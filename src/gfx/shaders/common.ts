/**
 * Shared GLSL for the post-processing chain.
 *
 * Every pass is a `RawShaderMaterial` at `GLSL3`, so three.js injects nothing:
 * no tone mapping, no colour-space conversion, no `#define` soup. That is
 * deliberate — the whole point of this chain is that exposure, tone mapping and
 * encoding happen exactly once, in the composite, in a known order. Anything
 * three.js "helpfully" applies behind our back would be a second, invisible
 * transform we could not account for.
 *
 * The maths here is shared rather than copy-pasted per pass so depth
 * linearisation, view reconstruction and the ACES fit can never disagree
 * between SSAO, volumetrics, TAA and the composite. A disagreement of one
 * matrix convention between passes is the classic source of "AO haloes on one
 * side of every object".
 */

/**
 * Fullscreen vertex shader.
 *
 * Draws a single oversized triangle rather than a quad: 3 vertices instead of 6,
 * no diagonal seam where the two triangles meet, and the rasteriser's quad
 * granularity stays aligned across the whole screen.
 */
export const GLSL_FULLSCREEN_VERT = /* glsl */ `
precision highp float;
in vec3 position;
out vec2 vUv;
void main(){
  vUv = position.xy * 0.5 + 0.5;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** Depth handling, view/world reconstruction, normal reconstruction. */
export const GLSL_DEPTH = /* glsl */ `
// A FloatType DepthTexture stores window-space z in [0,1]. Everything below
// assumes a standard (non-reversed) perspective projection.

float rawDepth(sampler2D tex, vec2 uv){
  return texture(tex, uv).x;
}

/** Window-space depth -> view-space z (negative, metres). */
float viewZFromDepth(float d, float near, float far){
  // d = 1.0 is the far plane / cleared background.
  float z = d * 2.0 - 1.0;
  return (2.0 * near * far) / (far + near - z * (far - near)) * -1.0;
}

/** Positive linear distance along -Z, in metres. Cheap and monotonic. */
float linearDepth(float d, float near, float far){
  return -viewZFromDepth(d, near, far);
}

/** 0..1 normalised linear depth, useful for bilateral weights. */
float linear01(float d, float near, float far){
  return clamp(linearDepth(d, near, far) / far, 0.0, 1.0);
}

/** Reconstruct a view-space position from uv + window depth. */
vec3 viewPosFromDepth(vec2 uv, float d, mat4 invProj){
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invProj * clip;
  return v.xyz / v.w;
}

/** Reconstruct a world-space position from uv + window depth. */
vec3 worldPosFromDepth(vec2 uv, float d, mat4 invViewProj){
  vec4 clip = vec4(uv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
  vec4 v = invViewProj * clip;
  return v.xyz / v.w;
}

/**
 * View-space normal from the depth buffer.
 *
 * The naive version (forward differences in x and y) bleeds across silhouettes
 * and produces a bright halo one pixel wide around every object. This picks,
 * per axis, whichever neighbour is closer in depth to the centre — the standard
 * "best-of-4" trick — so the plane is always fitted to the near surface.
 */
vec3 normalFromDepth(sampler2D tDepth, vec2 uv, vec2 texel, mat4 invProj){
  float d0 = rawDepth(tDepth, uv);
  vec3 p0 = viewPosFromDepth(uv, d0, invProj);

  float dl = rawDepth(tDepth, uv - vec2(texel.x, 0.0));
  float dr = rawDepth(tDepth, uv + vec2(texel.x, 0.0));
  float dd = rawDepth(tDepth, uv - vec2(0.0, texel.y));
  float du = rawDepth(tDepth, uv + vec2(0.0, texel.y));

  vec3 pl = viewPosFromDepth(uv - vec2(texel.x, 0.0), dl, invProj);
  vec3 pr = viewPosFromDepth(uv + vec2(texel.x, 0.0), dr, invProj);
  vec3 pd = viewPosFromDepth(uv - vec2(0.0, texel.y), dd, invProj);
  vec3 pu = viewPosFromDepth(uv + vec2(0.0, texel.y), du, invProj);

  vec3 dx = abs(pr.z - p0.z) < abs(p0.z - pl.z) ? (pr - p0) : (p0 - pl);
  vec3 dy = abs(pu.z - p0.z) < abs(p0.z - pd.z) ? (pu - p0) : (p0 - pd);

  vec3 n = cross(dx, dy);
  float l = length(n);
  return l > 1e-8 ? n / l : vec3(0.0, 0.0, 1.0);
}
`;

/**
 * G-buffer decode.
 *
 * Attachment 1 is written by every lit three.js material (see GBuffer's
 * ShaderChunk patch). Custom `ShaderMaterial`s — sky, water, VFX — declare only
 * colour, so their pixels hold whatever the clear left behind. Rather than
 * trust that, every read is validated: the alpha flag must be set AND the
 * encoded normal must decode to something near unit length AND be finite. Any
 * failure falls back to reconstructing from depth, which always works. That is
 * why no other subsystem is blocked on opting in.
 */
export const GLSL_GBUFFER = /* glsl */ `
struct GSample {
  vec3 normal;     // view space, unit length
  float roughness;
  bool valid;
};

GSample decodeGBuffer(sampler2D tNormal, vec2 uv){
  vec4 g = texture(tNormal, uv);
  GSample s;
  s.roughness = clamp(g.w, 0.02, 1.0);
  vec3 n = g.xyz * 2.0 - 1.0;
  float l = length(n);
  // g.w is written as roughness and is always > 0 for a real write; a cleared
  // texel decodes to n = (-1,-1,-1) with l = 1.732, so the length window plus
  // the finite test rejects both cleared and garbage texels.
  bool finite = !(isnan(l) || isinf(l));
  s.valid = finite && l > 0.55 && l < 1.45 && g.w > 0.001;
  s.normal = s.valid ? n / max(l, 1e-6) : vec3(0.0, 0.0, 1.0);
  return s;
}

/** Normal with an automatic depth fallback. Use this, never decodeGBuffer raw. */
vec3 sampleNormal(sampler2D tNormal, sampler2D tDepth, vec2 uv, vec2 texel, mat4 invProj){
  GSample g = decodeGBuffer(tNormal, uv);
  if (g.valid) return g.normal;
  return normalFromDepth(tDepth, uv, texel, invProj);
}
`;

/**
 * Noise. Two kinds, for two jobs.
 *
 * `blueNoise()` reads the void-and-cluster tile built in BlueNoise.ts and
 * rotates it per frame with the golden ratio — the standard trick that turns a
 * static tile into a temporally decorrelated sequence TAA can average away.
 * `ign()` is interleaved gradient noise: no texture fetch, ideal inside tight
 * ray-march loops where a second sampler would cost more than the quality.
 */
export const GLSL_NOISE_POST = /* glsl */ `
float hash12(vec2 p){
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}

/** Interleaved gradient noise (Jimenez). Screen-space, spectrally flat-ish. */
float ign(vec2 pixel){
  return fract(52.9829189 * fract(dot(pixel, vec2(0.06711056, 0.00583715))));
}

/** Blue-noise tile lookup, animated with the golden-ratio sequence. */
float blueNoise(sampler2D tex, vec2 pixel, float tileSize, float frame){
  float v = texture(tex, (pixel + 0.5) / tileSize).x;
  return fract(v + frame * 0.6180339887498949);
}

/** Two decorrelated blue-noise values (different golden-ratio strides). */
vec2 blueNoise2(sampler2D tex, vec2 pixel, float tileSize, float frame){
  vec2 v = texture(tex, (pixel + 0.5) / tileSize).xy;
  return fract(v + frame * vec2(0.7548776662466927, 0.5698402909980532));
}
`;

/** Colour space helpers. */
export const GLSL_COLOR = /* glsl */ `
float luminance(vec3 c){ return dot(c, vec3(0.2125, 0.7154, 0.0721)); }

vec3 srgbEncode(vec3 c){
  c = max(c, vec3(0.0));
  return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
}
vec3 srgbDecode(vec3 c){
  return mix(c / 12.92, pow((c + 0.055) / 1.055, vec3(2.4)), step(0.04045, c));
}

/**
 * YCoCg. TAA neighbourhood clipping works far better in a luma/chroma space
 * than in RGB: the variance box becomes an oriented box in the direction the
 * eye actually notices, which kills most of the classic purple-fringe ghosting
 * without needing a wider neighbourhood.
 */
vec3 rgbToYCoCg(vec3 c){
  return vec3(0.25 * c.r + 0.5 * c.g + 0.25 * c.b,
              0.5 * c.r - 0.5 * c.b,
             -0.25 * c.r + 0.5 * c.g - 0.25 * c.b);
}
vec3 ycocgToRgb(vec3 c){
  float y = c.x, co = c.y, cg = c.z;
  return vec3(y + co - cg, y + cg, y - co - cg);
}

/**
 * Reversible range compressor. Blending HDR values directly lets one 40.0
 * firefly dominate an 8-sample average forever; blending in compressed space
 * and expanding afterwards is what stops TAA from smearing sparks across the
 * screen.
 */
vec3 rangeCompress(vec3 c){ return c / (1.0 + max(max(c.r, c.g), c.b)); }
vec3 rangeExpand(vec3 c){ return c / max(1e-4, 1.0 - max(max(c.r, c.g), c.b)); }

/**
 * The real ACES RRT+ODT fit (Stephen Hill), not the 2-parameter Narkowicz
 * approximation three.js ships. The difference is visible exactly where it
 * matters for this art direction: saturated emissives (cyan Federation trim,
 * acid-green Mantis lights) desaturate toward white as they clip instead of
 * flattening into a solid primary blob.
 */
const mat3 ACES_INPUT = mat3(
  0.59719, 0.07600, 0.02840,
  0.35458, 0.90834, 0.13383,
  0.04823, 0.01566, 0.83777);
const mat3 ACES_OUTPUT = mat3(
   1.60475, -0.10208, -0.00327,
  -0.53108,  1.10813, -0.07276,
  -0.07367, -0.00605,  1.07602);

vec3 rrtOdtFit(vec3 v){
  vec3 a = v * (v + 0.0245786) - 0.000090537;
  vec3 b = v * (0.983729 * v + 0.4329510) + 0.238081;
  return a / b;
}
vec3 acesFitted(vec3 color){
  color = ACES_INPUT * max(color, vec3(0.0));
  color = rrtOdtFit(color);
  color = ACES_OUTPUT * color;
  return clamp(color, 0.0, 1.0);
}
`;

/** Catmull-Rom history resampling — the sharpness half of a good TAA. */
export const GLSL_BICUBIC = /* glsl */ `
/**
 * 5-tap Catmull-Rom, bilinear-accelerated (Filmic SMAA / Karis formulation).
 * Resampling the history with plain bilinear is what makes naive TAA look like
 * vaseline: every frame the image is filtered again, and the blur compounds.
 * Catmull-Rom's negative lobes put the high frequencies back.
 */
vec4 catmullRom(sampler2D tex, vec2 uv, vec2 size, vec2 texel){
  vec2 samplePos = uv * size;
  vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - texPos1;

  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);

  vec2 w12 = w1 + w2;
  vec2 offset12 = w2 / max(w12, vec2(1e-5));

  vec2 texPos0 = (texPos1 - 1.0) * texel;
  vec2 texPos3 = (texPos1 + 2.0) * texel;
  vec2 texPos12 = (texPos1 + offset12) * texel;

  vec4 result = vec4(0.0);
  result += texture(tex, vec2(texPos12.x, texPos0.y))  * (w12.x * w0.y);
  result += texture(tex, vec2(texPos0.x,  texPos12.y)) * (w0.x  * w12.y);
  result += texture(tex, vec2(texPos12.x, texPos12.y)) * (w12.x * w12.y);
  result += texture(tex, vec2(texPos3.x,  texPos12.y)) * (w3.x  * w12.y);
  result += texture(tex, vec2(texPos12.x, texPos3.y))  * (w12.x * w3.y);

  float wsum = (w12.x * w0.y) + (w0.x * w12.y) + (w12.x * w12.y)
             + (w3.x * w12.y) + (w12.x * w3.y);
  return result / max(wsum, 1e-5);
}
`;

/**
 * Screen-space velocity.
 *
 * Camera motion — which for a first-person shooter is nearly all the motion in
 * the frame — is recoverable exactly from depth plus the previous frame's
 * view-projection. Per-object velocity needs per-object history, which shared
 * materials cannot carry; GBuffer exposes an opt-in path for that and stamps
 * attachment 2's alpha when it is present. Everything else falls back here, so
 * TAA and motion blur work on day one with no cooperation from any other
 * subsystem.
 */
export const GLSL_VELOCITY = /* glsl */ `
/** Returns uv-space motion (current uv - previous uv). */
vec2 cameraVelocity(vec2 uv, float depth, mat4 invViewProj, mat4 prevViewProj){
  vec4 clip = vec4(uv * 2.0 - 1.0, depth * 2.0 - 1.0, 1.0);
  vec4 world = invViewProj * clip;
  world /= world.w;
  vec4 prevClip = prevViewProj * world;
  if (abs(prevClip.w) < 1e-6) return vec2(0.0);
  vec2 prevUv = (prevClip.xy / prevClip.w) * 0.5 + 0.5;
  return uv - prevUv;
}

/** Velocity with the opt-in object channel taking priority when stamped. */
vec2 sampleVelocity(sampler2D tVelocity, vec2 uv, float depth,
                    mat4 invViewProj, mat4 prevViewProj){
  vec4 v = texture(tVelocity, uv);
  bool finite = !(isnan(v.x) || isnan(v.y) || isinf(v.x) || isinf(v.y));
  if (finite && v.w > 0.5 && abs(v.x) < 2.0 && abs(v.y) < 2.0) return v.xy;
  return cameraVelocity(uv, depth, invViewProj, prevViewProj);
}
`;

/** Everything a pass normally wants, in one string. */
export const GLSL_POST_COMMON = [
  GLSL_DEPTH,
  GLSL_GBUFFER,
  GLSL_NOISE_POST,
  GLSL_COLOR,
  GLSL_VELOCITY,
].join('\n');
