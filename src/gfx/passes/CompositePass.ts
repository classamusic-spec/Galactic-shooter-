/**
 * The composite: everything from HDR radiance to the framebuffer, in one pass.
 *
 * Order is the whole design here. Each of these steps is a separate fullscreen
 * pass in a naive chain, and each one would cost a full read/write of a 1080p
 * HDR buffer. Fused, they cost one:
 *
 *   distortion warp -> chromatic aberration -> CAS sharpen -> auto-exposure
 *   -> SSAO -> volumetric inscatter -> aerial-perspective fog -> bloom
 *   -> ACES filmic -> sRGB encode -> 3D LUT grade -> damage vignette
 *   -> super flash -> lens vignette -> film grain
 *
 * A few orderings are load-bearing rather than arbitrary:
 *
 * - **Exposure before bloom and before tone mapping.** Bloom's threshold is
 *   evaluated in exposed space (see BloomPass), so what counts as an emissive
 *   tracks the eye's adaptation. Tone mapping last, on exposed values, is the
 *   only order that gives a filmic response instead of a clipped one.
 * - **AO and fog before bloom.** Otherwise a crevice darkened by AO still glows,
 *   and distant geometry blooms *through* the fog that should be hiding it.
 * - **Grade after the sRGB encode.** A film LUT is a look applied to a graded
 *   display image. Applying lift/gain in linear light crushes the shadows in a
 *   way no colourist would sign off on.
 * - **Grain last, luminance-weighted.** Grain in the midtones only. Uniform grain
 *   over crushed blacks is the single most common giveaway of a hobby post chain.
 *
 * Every user-facing knob in `settings.user` is honoured, and `reducedMotion`
 * suppresses the distortion warp, the damage vignette and the super flash
 * entirely — those are the three things that can make a player ill.
 */
import * as THREE from 'three';
import { FullscreenPass } from './FullscreenPass';
import { GLSL_COLOR, GLSL_DEPTH, GLSL_NOISE_POST, GLSL_VELOCITY } from '@/gfx/shaders/common';
import { GLSL_LUT, LUT_SIZE } from '@/gfx/shaders/lut';
import { BLUE_NOISE_TILE } from './BlueNoise';

/** Simultaneous screen-space distortion sources. */
export const MAX_DISTORTIONS = 8;

const FRAG = /* glsl */ `
${GLSL_DEPTH}
${GLSL_COLOR}
${GLSL_NOISE_POST}
${GLSL_VELOCITY}
${GLSL_LUT}

uniform sampler2D tColor;
uniform sampler2D tDepth;
uniform sampler2D tAo;
uniform sampler2D tVolumetric;
uniform sampler2D tBloom;
uniform sampler2D tExposure;
uniform sampler2D tNoise;

uniform mat4 uInvViewProj;
uniform mat4 uInvProjDebug;
uniform mat4 uPrevViewProjDebug;
uniform vec3 uCameraPos;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform vec3 uFogColor;
uniform vec3 uAoTint;
uniform vec3 uFlashColor;
uniform vec3 uDamageColor;

uniform vec2 uTexel;
uniform vec2 uSize;
uniform vec2 uHalfTexel;
uniform float uAspect;
uniform float uNear;
uniform float uFar;

uniform float uAoStrength;
uniform float uVolStrength;
uniform float uBloomStrength;
uniform float uFogDensity;
uniform float uFogHeightFalloff;
uniform float uFogGround;
uniform float uFogInscatter;
uniform float uFogMax;
uniform float uCaStrength;
uniform float uVignette;
uniform float uGrain;
uniform float uSharpen;
uniform float uDamage;
uniform float uFlash;
uniform float uFrame;
uniform float uDebugView;
uniform float uDistortCount;
uniform vec4 uDistort[${MAX_DISTORTIONS}];      // xy = screen uv, z = uv radius, w = strength
uniform vec2 uDistortWave[${MAX_DISTORTIONS}];  // x = phase, y = ring sharpness

// ---------------------------------------------------------------------------

/**
 * Joint bilateral upsample of a half-resolution buffer.
 *
 * Plain bilinear would bleed AO and light shafts across silhouettes, leaving the
 * bright halo that gives away every half-res effect. Weighting the four taps by
 * how well their stored linear depth matches this pixel's keeps the gradient
 * locked to the correct surface.
 */
vec4 upsample(sampler2D tex, vec2 uv, float centreZ, bool depthInAlpha){
  vec2 t = uHalfTexel;
  vec4 sum = vec4(0.0);
  float wsum = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 o = vec2(i == 0 || i == 2 ? -0.5 : 0.5, i < 2 ? -0.5 : 0.5) * t;
    vec4 s = texture(tex, uv + o);
    float z = depthInAlpha ? s.w : s.y;
    // Smooth falloff, not a reciprocal. 1/(eps + d) is near-singular: a tap whose
    // depth almost matches outweighs the others ~1000:1, so the filter collapses
    // onto a single half-res texel and the result quantises into visible
    // rectangles wherever depth varies quickly per pixel - which is exactly what
    // distant, densely tessellated terrain looks like.
    float w = exp(-abs(z - centreZ) / max(centreZ * 0.02, 0.05));
    sum += s * w;
    wsum += w;
  }
  return sum / max(wsum, 1e-5);
}

/**
 * Wider (3x3) version for the volumetric buffer.
 *
 * Light shafts come out of a stochastic march, so even after temporal
 * accumulation they carry low-frequency blotching that a 4-tap upsample happily
 * magnifies into visible clouds. Nine depth-weighted taps of a half-res buffer is
 * cheap and removes it without a dedicated blur pass.
 */
vec3 upsampleWide(sampler2D tex, vec2 uv, float centreZ){
  vec3 sum = vec3(0.0);
  float wsum = 0.0;
  for (int y = -1; y <= 1; y++) {
    for (int x = -1; x <= 1; x++) {
      vec2 o = vec2(float(x), float(y)) * uHalfTexel;
      vec4 s = texture(tex, uv + o);
      float w = exp(-abs(s.w - centreZ) / max(centreZ * 0.02, 0.05));
      w *= (x == 0 && y == 0) ? 2.0 : 1.0;
      sum += s.rgb * w;
      wsum += w;
    }
  }
  return sum / max(wsum, 1e-5);
}

/**
 * Analytic optical depth through an exponential height-fog medium.
 *
 * Sampling the medium per step would need a march; integrating it in closed form
 * costs two exp() calls and is exact. This is what makes distance genuinely
 * recede instead of just getting greyer.
 */
float heightFogOptical(vec3 a, vec3 b){
  float ha = max(a.y - uFogGround, 0.0);
  float hb = max(b.y - uFogGround, 0.0);
  float dist = length(b - a);
  float dh = hb - ha;
  float fa = exp(-ha * uFogHeightFalloff);
  if (abs(dh) < 1e-3) return uFogDensity * fa * dist;
  float fb = exp(-hb * uFogHeightFalloff);
  return uFogDensity * dist * (fa - fb) / (dh * uFogHeightFalloff);
}

/**
 * Contrast-adaptive sharpen (AMD FidelityFX CAS), 4-tap cross.
 *
 * ## Why the result is clamped to the neighbourhood
 *
 * CAS's amplitude term is derived from how close the *neighbourhood* already is
 * to the ends of the range, which tames ringing on a mid-contrast edge but does
 * nothing for the sky/terrain silhouette: there the four taps straddle a step of
 * most of the display range, that term stays high, and the negative lobe drives
 * the centre pixel below every one of its neighbours. Measured on Zeta Reticuli at
 * x=225 before this change: sky L=105, fringe L=88, terrain L=152. A pixel
 * *darker than both* its neighbours is not aliasing — a stair-step can only ever
 * land between the two values it is interpolating — it is sharpen undershoot,
 * and on Khepri's canopy it detached into free-floating black specks several
 * pixels clear of any geometry.
 *
 * Clamping the output into the min/max of the taps that produced it removes the
 * over/undershoot lobes entirely while keeping the acuity CAS is there for: the
 * edge still gets steeper, it just cannot overshoot past the values either side
 * of it. This is the standard fix for unsharp ringing and it costs two ALU ops.
 *
 * (The ridge fringe those measurements came from turned out to be the half-res
 * AO term, not this pass — see the AO block in main(). The clamp is still the
 * right thing to do, and CAS at 0.38 was still over-driven, but do not credit
 * this code with a fix it did not deliver.)
 */
vec3 casSharpen(vec3 e, vec3 a, vec3 b, vec3 c, vec3 d, float sharpness){
  vec3 mn = min(min(a, b), min(c, d));
  vec3 mx = max(max(a, b), max(c, d));
  // Amplitude falls off where the neighbourhood is already near the extremes,
  // which is what stops CAS from ringing on high-contrast edges the way a plain
  // unsharp mask does.
  vec3 amp = clamp(min(mn, 1.0 - mx) / max(mx, vec3(1e-4)), 0.0, 1.0);
  amp = sqrt(amp);
  float peak = -1.0 / mix(10.0, 6.0, clamp(sharpness, 0.0, 1.0));
  vec3 w = amp * peak * sharpness;
  vec3 sum = (a + b + c + d) * w + e;
  vec3 div = 1.0 + 4.0 * w;
  vec3 res = max(sum / max(div, vec3(1e-4)), vec3(0.0));
  // The centre pixel is allowed to move toward, but never past, the darkest and
  // brightest of the four it was sharpened against.
  return clamp(res, min(mn, e), max(mx, e));
}

/** Sum of every active ripple/heat source, in uv units. */
vec2 distortionOffset(vec2 uv){
  vec2 total = vec2(0.0);
  int count = int(uDistortCount + 0.5);
  for (int i = 0; i < ${MAX_DISTORTIONS}; i++) {
    if (i >= count) break;
    vec4 s = uDistort[i];
    vec2 wave = uDistortWave[i];
    // Correct for aspect so a shockwave is a circle, not an ellipse.
    vec2 d = (uv - s.xy) * vec2(uAspect, 1.0);
    float r = length(d);
    if (r > s.z || r < 1e-5) continue;
    float f = 1.0 - r / s.z;
    // A travelling ring rather than a bulge: sin() of the normalised radius
    // offset by the source's phase, windowed so it dies at the rim.
    float ring = sin(f * wave.y - wave.x);
    total += (d / r) * ring * f * f * s.w * vec2(1.0 / uAspect, 1.0);
  }
  return total;
}

// ---------------------------------------------------------------------------

void main(){
  vec2 uv = vUv;

  // -- debug views -----------------------------------------------------------
  // A post chain you cannot inspect buffer-by-buffer is a chain you cannot tune.
  // These are the views used to verify each stage in isolation; they short-circuit
  // before any of the artistic transforms so what you see is the raw buffer.
  if (uDebugView > 0.5) {
    float dd = rawDepth(tDepth, uv);
    float dz = dd >= 0.999999 ? uFar : linearDepth(dd, uNear, uFar);
    int mode = int(uDebugView + 0.5);
    vec3 out3 = vec3(0.0);
    if (mode == 1) {
      out3 = vec3(clamp(upsample(tAo, uv, dz, false).x, 0.0, 1.0));
    } else if (mode == 2) {
      out3 = srgbEncode(acesFitted(upsampleWide(tVolumetric, uv, dz) * 6.0));
    } else if (mode == 3) {
      out3 = normalFromDepth(tDepth, uv, uTexel, uInvProjDebug) * 0.5 + 0.5;
    } else if (mode == 4) {
      vec2 v = cameraVelocity(uv, dd, uInvViewProj, uPrevViewProjDebug) * 60.0;
      out3 = vec3(0.5 + v.x, 0.5 + v.y, 0.5);
    } else if (mode == 5) {
      out3 = srgbEncode(acesFitted(texture(tBloom, uv).rgb * 4.0));
    } else {
      out3 = vec3(clamp(dz / 120.0, 0.0, 1.0));
    }
    fragColor = vec4(clamp(out3, 0.0, 1.0), 1.0);
    return;
  }

  if (uDistortCount > 0.5) uv = clamp(uv + distortionOffset(uv), vec2(0.0), vec2(1.0));

  // -- chromatic aberration: radial, quadratic, so the centre stays clean -----
  vec2 fromCentre = uv - 0.5;
  float r2 = dot(fromCentre, fromCentre);
  vec2 caOffset = fromCentre * r2 * uCaStrength;
  vec3 hdr;
  if (uCaStrength > 1e-5) {
    hdr.r = texture(tColor, uv + caOffset).r;
    hdr.g = texture(tColor, uv).g;
    hdr.b = texture(tColor, uv - caOffset).b;
  } else {
    hdr = texture(tColor, uv).rgb;
  }
  hdr = max(hdr, vec3(0.0));

  // -- depth-derived world position ------------------------------------------
  // Read before the sharpen: sharpening is gated on depth, and re-reading the
  // depth buffer twice per pixel to keep the old ordering would cost more than
  // moving three lines.
  float depth = rawDepth(tDepth, uv);
  bool isSky = depth >= 0.999999;
  float linZ = isSky ? uFar : linearDepth(depth, uNear, uFar);

  // -- CAS, evaluated in compressed [0,1] space ------------------------------
  // Sharpening raw HDR means the amplitude term (which assumes a 0..1 range) is
  // meaningless and bright pixels get sharpened 40x harder than dark ones.
  //
  // Gated by depth, for two independent reasons:
  //
  //  - **Distance.** Sharpen exists to put back the acuity TAA takes out of
  //    surfaces the player is looking *at*. Beyond a few tens of metres every
  //    remaining high-frequency is either aerial perspective or terrain noise,
  //    and sharpening it only makes the distance read closer — the opposite of
  //    what the depth cue is for.
  //  - **Silhouettes.** The 4-tap cross straddling a sky/terrain edge is the one
  //    configuration where CAS's amplitude term cannot save it. Detecting the
  //    depth step directly and standing down is exact, where tuning the strength
  //    down globally only makes the fringe fainter.
  //
  // Note for the next person: this pass was *not* the cause of the dotted
  // outline along distant ridge tops. Forcing uSharpen to zero and re-shooting
  // leaves that artefact untouched; it is the half-res AO term, gated further
  // down. The sharpen was over-driven all the same, so the clamp and the gates
  // stay.
  //
  // The ceiling belongs to the pass, not to its caller: even with the
  // neighbourhood clamp, CAS's negative lobe becomes a visible halo above about
  // 0.18, and the caller has no way to know that. PostFX drives 0.38 with TAA on
  // and 0.12 without, and 0.38 was measured ringing every silhouette in the game.
  //
  // How far this pixel's depth is from its neighbours', in metres. Computed once
  // and used twice: it gates the sharpen below and the AO further down, and both
  // want the same question answered — "is this pixel on a silhouette?".
  // The taps are two texels out rather than one, because the half-resolution AO
  // buffer's artefacts are two full-res pixels wide.
  float zl = linearDepth(rawDepth(tDepth, uv + vec2(-2.0 * uTexel.x, 0.0)), uNear, uFar);
  float zr = linearDepth(rawDepth(tDepth, uv + vec2( 2.0 * uTexel.x, 0.0)), uNear, uFar);
  float zd = linearDepth(rawDepth(tDepth, uv + vec2(0.0, -2.0 * uTexel.y)), uNear, uFar);
  float zu = linearDepth(rawDepth(tDepth, uv + vec2(0.0,  2.0 * uTexel.y)), uNear, uFar);
  float depthStep = max(max(abs(zl - linZ), abs(zr - linZ)), max(abs(zd - linZ), abs(zu - linZ)));
  // 4% of the receiver's own depth is comfortably more than any real surface
  // slope produces across two texels and comfortably less than a silhouette.
  float silhouette = smoothstep(max(linZ * 0.04, 0.05), max(linZ * 0.12, 0.15), depthStep);

  float sharpen = min(uSharpen, 0.18);
  if (sharpen > 1e-4) {
    // Full strength inside 18 m, gone by 55 m; nothing at all on the sky, and
    // nothing across a silhouette.
    sharpen *= isSky ? 0.0 : (1.0 - smoothstep(18.0, 55.0, linZ)) * (1.0 - silhouette);
  }
  if (sharpen > 1e-4) {
    vec3 e = rangeCompress(hdr);
    vec3 a = rangeCompress(max(texture(tColor, uv + vec2(-uTexel.x, 0.0)).rgb, vec3(0.0)));
    vec3 b = rangeCompress(max(texture(tColor, uv + vec2( uTexel.x, 0.0)).rgb, vec3(0.0)));
    vec3 c = rangeCompress(max(texture(tColor, uv + vec2(0.0, -uTexel.y)).rgb, vec3(0.0)));
    vec3 d = rangeCompress(max(texture(tColor, uv + vec2(0.0,  uTexel.y)).rgb, vec3(0.0)));
    hdr = rangeExpand(clamp(casSharpen(e, a, b, c, d, sharpen), 0.0, 0.999));
  }

  // -- exposure --------------------------------------------------------------
  float exposure = texture(tExposure, vec2(0.5)).x;
  if (!(exposure > 0.0) || isnan(exposure) || isinf(exposure)) exposure = 1.0;
  hdr *= exposure;

  vec3 world = worldPosFromDepth(uv, min(depth, 0.9999995), uInvViewProj);

  // -- ambient occlusion -----------------------------------------------------
  if (uAoStrength > 1e-4 && !isSky) {
    float ao = clamp(upsample(tAo, uv, linZ, false).x, 0.0, 1.0);
    // Stand the AO down across silhouettes.
    //
    // This is the fix for the "faint dotted outline along distant ridge tops"
    // that three review passes recorded as silhouette aliasing. It is neither
    // aliasing nor, as later supposed, sharpen undershoot: forcing this whole
    // block off makes the dashed line along Zeta's ridge vanish completely,
    // while forcing the sharpen to zero leaves it exactly as it was.
    //
    // The cause is that GTAO runs at half resolution and takes its shading
    // normal from a depth gradient. A depth gradient across a silhouette is not
    // a normal — it points along the step — so the integral built on it reports
    // heavy occlusion, and since that texel's depth then agrees with nothing
    // nearby, both the bilateral blur and the depth-aware upsample preserve the
    // bad value instead of filtering it out. On Khepri's canopy the same thing
    // detached into black specks several pixels clear of any geometry.
    ao = mix(ao, 1.0, silhouette);
    // Power curve tightens the falloff so open surfaces stay at 1.0 instead of
    // drifting into the grey wash that gives cheap SSAO away.
    // A power of 2 is what turns a measured visibility term into readable art
    // direction: open surfaces stay at 1.0, and the deep creases that GTAO scores
    // around 0.7 land near 0.5 where the eye can actually see them.
    ao = pow(ao, 2.0);
    float amount = mix(1.0, ao, uAoStrength);
    // Occlusion is tinted with the sky-fill hue rather than neutral grey: a
    // crease loses the *bounce* light, which was coloured, so a grey multiply
    // reads as dirt while a tinted one reads as shadow.
    hdr *= mix(uAoTint, vec3(1.0), amount);
  }

  // -- volumetric inscatter --------------------------------------------------
  if (uVolStrength > 1e-4) {
    vec3 shafts = max(upsampleWide(tVolumetric, uv, linZ), vec3(0.0));
    hdr += shafts * uVolStrength;
  }

  // -- aerial perspective ----------------------------------------------------
  if (uFogDensity > 1e-6 && !isSky) {
    float optical = heightFogOptical(uCameraPos, world);
    float fog = 1.0 - exp(-max(optical, 0.0));
    fog = min(fog, uFogMax);
    vec3 rayDir = normalize(world - uCameraPos);
    // Forward scattering: haze between you and the sun glows. This single term
    // does more for perceived production value than any amount of extra geometry.
    float forward = pow(clamp(dot(rayDir, uSunDir), 0.0, 1.0), 6.0);
    vec3 fogCol = uFogColor + uSunColor * (forward * uFogInscatter);
    hdr = mix(hdr, fogCol, fog);
  }

  // -- bloom -----------------------------------------------------------------
  if (uBloomStrength > 1e-4) {
    vec3 bloom = max(texture(tBloom, uv).rgb, vec3(0.0));
    hdr += bloom * uBloomStrength;
  }

  // -- tone map + encode -----------------------------------------------------
  vec3 mapped = acesFitted(hdr);
  vec3 display = srgbEncode(mapped);

  // -- grade -----------------------------------------------------------------
  display = applyLut(display);

  // -- damage / super feedback ----------------------------------------------
  float edge = clamp(length(fromCentre) * 1.42, 0.0, 1.0);
  if (uDamage > 1e-4) {
    float band = smoothstep(0.35, 1.0, edge);
    display = mix(display, uDamageColor, band * uDamage);
  }
  if (uFlash > 1e-4) {
    display = mix(display, uFlashColor, uFlash);
  }

  // -- lens vignette ---------------------------------------------------------
  if (uVignette > 1e-4) {
    // Natural cos^4-ish falloff rather than a hard radial ramp, so the corners
    // darken without a visible ring.
    float v = 1.0 - uVignette * 0.42 * pow(edge, 2.6);
    display *= clamp(v, 0.0, 1.0);
  }

  // -- film grain ------------------------------------------------------------
  if (uGrain > 1e-4) {
    vec2 pixel = uv * uSize;
    vec2 n2 = blueNoise2(tNoise, pixel, ${BLUE_NOISE_TILE}.0, uFrame);
    // Two decorrelated samples summed give an approximately triangular
    // distribution, which looks like film and dithers 8-bit banding away.
    float n = (n2.x + n2.y - 1.0);
    float l = luminance(display);
    // Peaks in the midtones, vanishes in crushed blacks and clipped whites —
    // uniform grain over black is the classic amateur tell.
    float weight = 1.0 - abs(l * 2.0 - 1.0);
    // Only a small floor in the extremes: at 0.25 the grain was clearly visible
    // as speckle across a night sky, which is exactly the "amateur post" tell
    // this weighting exists to avoid.
    display += n * uGrain * (0.1 + 0.9 * weight);
  }

  fragColor = vec4(clamp(display, 0.0, 1.0), 1.0);
}
`;

export class CompositePass {
  readonly pass: FullscreenPass;

  constructor() {
    const distort: THREE.Vector4[] = [];
    const wave: THREE.Vector2[] = [];
    for (let i = 0; i < MAX_DISTORTIONS; i++) {
      distort.push(new THREE.Vector4());
      wave.push(new THREE.Vector2());
    }
    this.pass = new FullscreenPass(FRAG, {
      tColor: { value: null },
      tDepth: { value: null },
      tAo: { value: null },
      tVolumetric: { value: null },
      tBloom: { value: null },
      tExposure: { value: null },
      tNoise: { value: null },
      tLut: { value: null },
      uInvViewProj: { value: new THREE.Matrix4() },
      uInvProjDebug: { value: new THREE.Matrix4() },
      uPrevViewProjDebug: { value: new THREE.Matrix4() },
      uCameraPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunColor: { value: new THREE.Color(1, 1, 1) },
      uFogColor: { value: new THREE.Color(0.5, 0.6, 0.7) },
      uAoTint: { value: new THREE.Color(0.12, 0.16, 0.22) },
      uFlashColor: { value: new THREE.Color(1, 1, 1) },
      uDamageColor: { value: new THREE.Color(0.55, 0.05, 0.06) },
      uTexel: { value: new THREE.Vector2() },
      uSize: { value: new THREE.Vector2() },
      uHalfTexel: { value: new THREE.Vector2() },
      uAspect: { value: 1 },
      uNear: { value: 0.1 },
      uFar: { value: 1000 },
      uAoStrength: { value: 0.9 },
      uVolStrength: { value: 1 },
      uBloomStrength: { value: 0.06 },
      uFogDensity: { value: 0.004 },
      uFogHeightFalloff: { value: 0.035 },
      uFogGround: { value: 0 },
      uFogInscatter: { value: 0.55 },
      uFogMax: { value: 0.92 },
      uCaStrength: { value: 0.006 },
      uVignette: { value: 0.75 },
      uGrain: { value: 0.035 },
      // Ceiling, not a target: the shader clamps to 0.18 regardless (see the CAS
      // block for why), and PostFX overwrites this every frame.
      uSharpen: { value: 0.18 },
      uDamage: { value: 0 },
      uFlash: { value: 0 },
      uFrame: { value: 0 },
      uDebugView: { value: 0 },
      uDistortCount: { value: 0 },
      uDistort: { value: distort },
      uDistortWave: { value: wave },
      uLutSize: { value: LUT_SIZE },
      uLutStrength: { value: 1 },
    });
  }

  get uniforms(): Record<string, THREE.IUniform> {
    return this.pass.uniforms;
  }

  dispose(): void {
    this.pass.dispose();
  }
}
