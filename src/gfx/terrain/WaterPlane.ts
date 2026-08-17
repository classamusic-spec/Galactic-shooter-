/**
 * WaterPlane — a camera-following water/lava body that reads its own depth from
 * the analytic heightfield.
 *
 * The usual way to do shoreline foam and depth absorption is to sample a scene
 * depth buffer, which costs a pre-pass and always fights transparency sorting.
 * We have something better: the terrain is a closed-form function, so a water
 * vertex can simply *ask* how deep it is. Absorption, foam bands, wave damping in
 * the shallows and the shoreline cutoff all fall out of one `gfHeight()` call
 * per vertex — no depth texture, no sorting hazard, exact against collision.
 *
 * The material is a patched `MeshStandardMaterial` rather than a bespoke
 * `ShaderMaterial`, which buys real IBL reflection of the sky (the PMREM
 * environment *is* the sky), the engine's shadows, its fog and its tone mapping
 * for free. Water at roughness 0.04 with F0 0.04 gets correct Fresnel out of the
 * standard BRDF; hand-rolling a fresnel term on top would double-count it.
 */
import * as THREE from 'three';
import type { MaterialLibrary } from '@/gfx/materials/MaterialLibrary';
import { TERRAIN_GLSL_BODY, TERRAIN_GLSL_UNIFORMS, type HeightField, type TerrainWaterSpec } from './HeightField';

export class WaterPlane {
  readonly mesh: THREE.Mesh;
  readonly material: THREE.MeshStandardMaterial;
  private spec: TerrainWaterSpec;
  private geometry: THREE.PlaneGeometry;
  private snap: number;
  private uniforms: Record<string, THREE.IUniform>;

  /**
   * @param shared terrain field uniforms — pass `heightField.uniforms()` (the
   *   same object handed to the terrain material) so one update drives both.
   */
  constructor(
    materials: MaterialLibrary,
    field: HeightField,
    spec: TerrainWaterSpec,
    shared: Record<string, THREE.IUniform>,
    segments: number,
  ) {
    this.spec = spec;
    const set = materials.pbr('water');

    this.uniforms = {
      ...shared,
      uWaterTime: { value: 0 },
      uWaterLevel: { value: spec.level },
      uWaterNormal: { value: set.normal },
      uWaveScale: { value: spec.waveScale },
      uWaveSpeed: { value: spec.waveSpeed },
      uWaveHeight: { value: spec.waveHeight },
      uAbsorb: { value: Math.max(spec.absorption, 0.05) },
      uFoamDepth: { value: Math.max(spec.foamDepth, 0.05) },
      uShallow: { value: new THREE.Color(spec.shallow).convertSRGBToLinear() },
      uDeep: { value: new THREE.Color(spec.deep).convertSRGBToLinear() },
      uFoamColor: { value: new THREE.Color(spec.foam).convertSRGBToLinear() },
      uGloss: { value: spec.glossiness },
      uEmissiveMix: { value: spec.emissive ? 1 : 0 },
    };

    this.geometry = new THREE.PlaneGeometry(1, 1, segments, segments);
    this.geometry.rotateX(-Math.PI / 2);

    const mat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.06,
      metalness: 0,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      envMapIntensity: 1.5,
    });
    mat.envMap = materials.environment;
    if (spec.emissive) {
      mat.emissive = new THREE.Color(spec.emissive);
      mat.emissiveIntensity = spec.emissiveIntensity;
    }
    this.patch(mat);
    this.material = mat;

    this.mesh = new THREE.Mesh(this.geometry, mat);
    this.mesh.name = 'water';
    this.mesh.scale.set(spec.extent * 2, 1, spec.extent * 2);
    this.mesh.position.y = spec.level;
    this.mesh.receiveShadow = false;
    this.mesh.castShadow = false;
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 4;
    // A snap step keeps the vertex lattice stable in world space, so the wave
    // pattern does not crawl as the camera walks.
    this.snap = (spec.extent * 2) / segments;
  }

  private patch(mat: THREE.MeshStandardMaterial): void {
    const uniforms = this.uniforms;

    const vertexPrefix = /* glsl */ `
      ${TERRAIN_GLSL_UNIFORMS}
      ${TERRAIN_GLSL_BODY}
      uniform float uWaterTime;
      uniform float uWaterLevel;
      uniform float uWaveHeight;
      varying float vWDepth;
      varying vec3  vWWorld;
      varying float vWMacro;
    `;

    const fragmentPrefix = /* glsl */ `
      uniform float uWaterTime;
      uniform float uWaterLevel;
      uniform sampler2D uWaterNormal;
      uniform float uWaveScale;
      uniform float uWaveSpeed;
      uniform float uAbsorb;
      uniform float uFoamDepth;
      uniform vec3  uShallow;
      uniform vec3  uDeep;
      uniform vec3  uFoamColor;
      uniform float uGloss;
      uniform float uEmissiveMix;
      varying float vWDepth;
      varying vec3  vWWorld;
      varying float vWMacro;

      vec3 gfWaterNormal(out float chop){
        // Two normal fields at different scales scrolling in different
        // directions. One layer alone always reads as a sliding texture; the
        // beat between two removes any sense of a repeating pattern.
        vec2 uv1 = vWWorld.xz / uWaveScale + vec2(0.021, 0.013) * uWaterTime * uWaveSpeed;
        vec2 uv2 = vWWorld.xz / (uWaveScale * 0.41) + vec2(-0.017, 0.029) * uWaterTime * uWaveSpeed;
        vec3 n1 = texture2D(uWaterNormal, uv1).xyz * 2.0 - 1.0;
        vec3 n2 = texture2D(uWaterNormal, uv2).xyz * 2.0 - 1.0;
        vec2 xy = n1.xy + n2.xy * 0.72;
        chop = length(xy);
        // Planar XZ frame: tangent +X, bitangent +Z, normal +Y.
        return normalize(vec3(xy.x, 2.6, xy.y));
      }
    `;

    mat.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, uniforms);

      shader.vertexShader = shader.vertexShader
        .replace('void main() {', `${vertexPrefix}\nvoid main() {`)
        .replace(
          '#include <begin_vertex>',
          /* glsl */ `
          vec3 transformed = vec3( position );
          vec2 gfXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz;
          float gfGround = gfHeight( gfXZ );
          vWDepth  = uWaterLevel - gfGround;
          vWWorld  = vec3( gfXZ.x, uWaterLevel, gfXZ.y );
          vWMacro  = gfFbm( gfXZ * 0.021, 3, 2.05, 0.5, uint(uGfSeed) + 907u );
          // Swell: three crossed sines, damped to nothing in the shallows so the
          // surface never lifts off the shoreline it is supposed to meet.
          float gfShallow = clamp( vWDepth / 2.2, 0.0, 1.0 );
          float gfSwell =
              sin( gfXZ.x * 0.13 + uWaterTime * 0.91 ) * 0.55
            + sin( gfXZ.y * 0.17 - uWaterTime * 1.23 ) * 0.38
            + sin( ( gfXZ.x + gfXZ.y ) * 0.071 + uWaterTime * 0.57 ) * 0.47;
          transformed.y += gfSwell * uWaveHeight * gfShallow;
        `,
        );

      shader.fragmentShader = shader.fragmentShader
        .replace('void main() {', `${fragmentPrefix}\nvoid main() {`)
        .replace(
          '#include <map_fragment>',
          /* glsl */ `
          // Everything above the waterline is simply not water. Clipping against
          // the heightfield is what makes a lake fit its basin exactly.
          if ( vWDepth < -0.35 ) discard;

          float gfChop;
          vec3 gfN = gfWaterNormal( gfChop );
          float gfD = max( vWDepth, 0.0 );

          // Beer-Lambert absorption: shallow tint bleeding into the deep body.
          float gfK = 1.0 - exp( -gfD / uAbsorb );
          vec3 gfBody = mix( uShallow, uDeep, gfK );
          gfBody *= 0.86 + vWMacro * 0.22;

          // Shoreline foam: a band set by depth, broken up by the chop and
          // pumped by a wash that runs up the beach.
          float gfBand = 1.0 - smoothstep( 0.0, uFoamDepth, gfD );
          float gfWash = sin( gfD * 3.1 - uWaterTime * 1.8 + vWMacro * 4.0 ) * 0.5 + 0.5;
          float gfFoam = gfBand * ( 0.35 + 0.65 * gfWash ) * ( 0.55 + gfChop * 1.1 );
          gfFoam = smoothstep( 0.30, 0.78, gfFoam );
          // A second, tighter line right at the edge reads as the wet margin.
          gfFoam = max( gfFoam, 1.0 - smoothstep( 0.0, uFoamDepth * 0.28, gfD ) );

          diffuseColor.rgb *= mix( gfBody, uFoamColor, gfFoam );
          diffuseColor.a *= mix( 0.55, 0.97, gfK );
          diffuseColor.a = max( diffuseColor.a, gfFoam * 0.95 );
          // Soft edge instead of a stair-stepped shoreline.
          diffuseColor.a *= smoothstep( -0.06, 0.10, vWDepth );

          float gfRough = mix( 0.035, 0.74, gfFoam ) * ( 1.0 / max( uGloss, 0.05 ) );
        `,
        )
        .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = clamp( gfRough, 0.02, 1.0 );')
        .replace(
          '#include <normal_fragment_maps>',
          'normal = normalize( ( viewMatrix * vec4( gfN, 0.0 ) ).xyz );',
        )
        .replace(
          '#include <emissivemap_fragment>',
          /* glsl */ `
          // Lava: the glow lives in the cracks between cooled crust plates, so
          // the emissive is masked by the macro field rather than uniform.
          float gfCrust = smoothstep( 0.10, 0.55, abs( vWMacro ) + gfChop * 0.35 );
          totalEmissiveRadiance *= mix( 1.0, pow( 1.0 - gfCrust, 2.2 ) * 1.6 + 0.05, uEmissiveMix );
        `,
        );
    };
    mat.customProgramCacheKey = () => 'gfWater';
  }

  /** Follow the camera in XZ and advance the wave clock. */
  update(elapsed: number, camera: THREE.Camera): void {
    this.uniforms.uWaterTime.value = elapsed;
    const p = camera.position;
    const s = this.snap;
    this.mesh.position.set(Math.round(p.x / s) * s, this.spec.level, Math.round(p.z / s) * s);
  }

  get level(): number {
    return this.spec.level;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}
