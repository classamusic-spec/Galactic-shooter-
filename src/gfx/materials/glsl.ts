/**
 * Shared GLSL library for procedural texture baking.
 *
 * These are strings rather than files so Vite doesn't need a glsl plugin and so
 * they can be composed by the surface recipes at bake time. Everything here is
 * pure — no texture reads — because the whole point is to synthesise detail from
 * maths instead of shipping image files.
 */

/** Hashes and value/gradient noise. The workhorse of every surface. */
export const GLSL_NOISE = /* glsl */ `
// -- hashing ----------------------------------------------------------------
float hash11(float p){ p = fract(p*0.1031); p *= p+33.33; p *= p+p; return fract(p); }
vec2  hash22(vec2 p){
  vec3 p3 = fract(vec3(p.xyx)*vec3(0.1031,0.1030,0.0973));
  p3 += dot(p3, p3.yzx+33.33);
  return fract((p3.xx+p3.yz)*p3.zy);
}
float hash21(vec2 p){
  vec3 p3 = fract(vec3(p.xyx)*0.1031);
  p3 += dot(p3, p3.yzx+33.33);
  return fract((p3.x+p3.y)*p3.z);
}
vec3 hash33(vec3 p){
  p = vec3(dot(p,vec3(127.1,311.7,74.7)), dot(p,vec3(269.5,183.3,246.1)), dot(p,vec3(113.5,271.9,124.6)));
  return fract(sin(p)*43758.5453);
}
float hash31(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453); }

// -- gradient noise ---------------------------------------------------------
float gnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  float a = hash21(i);
  float b = hash21(i+vec2(1.0,0.0));
  float c = hash21(i+vec2(0.0,1.0));
  float d = hash21(i+vec2(1.0,1.0));
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y)*2.0-1.0;
}
float gnoise3(vec3 p){
  vec3 i = floor(p), f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float n000=hash31(i), n100=hash31(i+vec3(1,0,0));
  float n010=hash31(i+vec3(0,1,0)), n110=hash31(i+vec3(1,1,0));
  float n001=hash31(i+vec3(0,0,1)), n101=hash31(i+vec3(1,0,1));
  float n011=hash31(i+vec3(0,1,1)), n111=hash31(i+vec3(1,1,1));
  return mix(mix(mix(n000,n100,u.x),mix(n010,n110,u.x),u.y),
             mix(mix(n001,n101,u.x),mix(n011,n111,u.x),u.y),u.z)*2.0-1.0;
}

// -- periodic (seamless) noise ----------------------------------------------
// A baked texture that does not tile shows its seam the moment it repeats on a
// wall. Wrapping the integer lattice through mod() before hashing makes the
// noise exactly periodic, so every texture in the game is seamless by default.
float pnoise(vec2 p, float period){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f*f*(3.0-2.0*f);
  vec2 i0 = mod(i, period);
  vec2 i1 = mod(i + vec2(1.0, 0.0), period);
  vec2 i2 = mod(i + vec2(0.0, 1.0), period);
  vec2 i3 = mod(i + vec2(1.0, 1.0), period);
  float a = hash21(i0), b = hash21(i1), c = hash21(i2), d = hash21(i3);
  return mix(mix(a,b,u.x), mix(c,d,u.x), u.y)*2.0-1.0;
}
// Seamless fBm. 'period' is in the same units as 'p' at the first octave.
float pfbm(vec2 p, float period, int octaves, float gain){
  float s = 0.0, a = 0.5, per = period;
  for(int i=0;i<8;i++){
    if(i>=octaves) break;
    s += a * pnoise(p * (per/period), per);
    per *= 2.0; a *= gain;
  }
  return s;
}
/** Seamless ridged multifractal — rock strata that never shows a repeat seam. */
float pridged(vec2 p, float period, int octaves, float gain){
  float s = 0.0, a = 0.5, per = period, prev = 1.0;
  for(int i=0;i<8;i++){
    if(i>=octaves) break;
    float n = 1.0 - abs(pnoise(p * (per/period), per));
    n *= n;
    s += a * n * prev;
    prev = n;
    per *= 2.0; a *= gain;
  }
  return s*2.0-1.0;
}
/** Seamless Worley. Cells wrap on the same lattice period. */
vec3 pworley(vec2 p, float period){
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 cell = mod(ip + g, period);
    vec2 o = hash22(cell);
    float d = length(g + o - fp);
    if(d < f1){ f2 = f1; f1 = d; id = hash21(cell); }
    else if(d < f2){ f2 = d; }
  }
  return vec3(f1, f2, id);
}

// -- fractal sums -----------------------------------------------------------
float fbm(vec2 p, int octaves, float lacunarity, float gain){
  float s=0.0, a=0.5;
  for(int i=0;i<10;i++){ if(i>=octaves) break; s += a*gnoise(p); p*=lacunarity; a*=gain; }
  return s;
}
float fbm3(vec3 p, int octaves, float lacunarity, float gain){
  float s=0.0, a=0.5;
  for(int i=0;i<10;i++){ if(i>=octaves) break; s += a*gnoise3(p); p*=lacunarity; a*=gain; }
  return s;
}
/** Ridged multifractal — the shape that makes rock read as rock. */
float ridged(vec2 p, int octaves, float lacunarity, float gain){
  float s=0.0, a=0.5, prev=1.0;
  for(int i=0;i<10;i++){
    if(i>=octaves) break;
    float n = 1.0 - abs(gnoise(p));
    n *= n;
    s += a * n * prev;
    prev = n;
    p *= lacunarity; a *= gain;
  }
  return s*2.0-1.0;
}
float billow(vec2 p, int octaves){
  float s=0.0,a=0.5;
  for(int i=0;i<10;i++){ if(i>=octaves) break; s += a*abs(gnoise(p)); p*=2.03; a*=0.5; }
  return s*2.0-1.0;
}

// -- cellular ---------------------------------------------------------------
/** Worley. Returns (F1, F2, cellId) — F2-F1 gives crack/edge masks. */
vec3 worley(vec2 p){
  vec2 ip = floor(p), fp = fract(p);
  float f1 = 8.0, f2 = 8.0, id = 0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g = vec2(float(i), float(j));
    vec2 o = hash22(ip+g);
    float d = length(g + o - fp);
    if(d < f1){ f2 = f1; f1 = d; id = hash21(ip+g); }
    else if(d < f2){ f2 = d; }
  }
  return vec3(f1, f2, id);
}
/** Voronoi with a hard cell colour, for aggregate/plate patterns. */
vec4 voronoi(vec2 p){
  vec2 ip=floor(p), fp=fract(p);
  float best=8.0; vec2 bestCell=vec2(0.0); float bestId=0.0;
  for(int j=-1;j<=1;j++) for(int i=-1;i<=1;i++){
    vec2 g=vec2(float(i),float(j));
    vec2 o=hash22(ip+g);
    float d=length(g+o-fp);
    if(d<best){ best=d; bestCell=ip+g; bestId=hash21(ip+g); }
  }
  return vec4(best, bestCell, bestId);
}

// -- domain warping ---------------------------------------------------------
vec2 warp(vec2 p, float amount, float freq){
  return p + amount*vec2(fbm(p*freq+vec2(1.7,9.2),4,2.0,0.5),
                         fbm(p*freq+vec2(8.3,2.8),4,2.0,0.5));
}

// -- utility ----------------------------------------------------------------
float sstep(float a, float b, float x){ return smoothstep(a,b,x); }
float remap01(float v, float a, float b){ return clamp((v-a)/(b-a), 0.0, 1.0); }
vec3 hsv2rgb(vec3 c){
  vec4 K = vec4(1.0, 2.0/3.0, 1.0/3.0, 3.0);
  vec3 p = abs(fract(c.xxx + K.xyz)*6.0 - K.www);
  return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
}
/** Cheap approximate sRGB->linear for authoring colours as hex. */
vec3 srgbToLinear(vec3 c){ return pow(c, vec3(2.2)); }
/**
 * Anisotropic brushed grain. The domain is stretched along one axis so detail is
 * fine across the brush direction and smeared along it. An earlier version
 * quantised rows with floor(), which produced hard horizontal banding on every
 * metal surface instead of a brushed finish.
 */
float brushedGrain(vec2 uv, float across, float along){
  vec2 q = vec2(uv.x * across, uv.y * along);
  return pfbm(q, max(across, along), 4, 0.55);
}
/** Scratch field: sparse thin lines at random angles. */
float scratches(vec2 uv, float density, float thin){
  float acc = 0.0;
  for(int i=0;i<6;i++){
    float fi = float(i);
    float a = hash11(fi*3.7)*3.14159;
    vec2 dir = vec2(cos(a), sin(a));
    float proj = dot(uv, dir)*density + hash11(fi*7.1)*10.0;
    float line = abs(fract(proj)-0.5);
    float m = 1.0 - smoothstep(0.0, thin, line);
    m *= step(0.55, hash21(vec2(floor(proj), fi)));
    acc = max(acc, m);
  }
  return acc;
}
`;

/**
 * The bake wrapper. A surface recipe supplies a `surface()` function; this shell
 * calls it, derives the normal from the height field by central differences (so
 * normals can never disagree with the albedo), and writes the three targets.
 */
export const GLSL_BAKE_MAIN = /* glsl */ `
layout(location = 0) out vec4 outAlbedo;
layout(location = 1) out vec4 outNormal;
layout(location = 2) out vec4 outOrm;

in vec2 vUv;
uniform float uTexel;       // 1.0 / resolution
uniform float uNormalScale; // height-to-normal strength
uniform float uSeed;

// Provided by the recipe:
//   void surface(vec2 uv, out vec3 albedo, out float height,
//                out float rough, out float metal, out float ao);
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao);

float heightOnly(vec2 uv){
  vec3 a; float h, r, m, o;
  surface(uv, a, h, r, m, o);
  return h;
}

void main(){
  vec3 albedo; float height, rough, metal, ao;
  surface(vUv, albedo, height, rough, metal, ao);

  // Central differences on the same height function the albedo was derived from.
  float e = uTexel;
  float hL = heightOnly(vUv - vec2(e,0.0));
  float hR = heightOnly(vUv + vec2(e,0.0));
  float hD = heightOnly(vUv - vec2(0.0,e));
  float hU = heightOnly(vUv + vec2(0.0,e));
  vec3 n = normalize(vec3((hL-hR)*uNormalScale, (hD-hU)*uNormalScale, 2.0*e*4.0));

  outAlbedo = vec4(albedo, 1.0);
  outNormal = vec4(n*0.5+0.5, 1.0);
  outOrm    = vec4(ao, rough, metal, 1.0);
}
`;

export const GLSL_BAKE_VERTEX = /* glsl */ `
in vec3 position;
in vec2 uv;
out vec2 vUv;
void main(){
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;
