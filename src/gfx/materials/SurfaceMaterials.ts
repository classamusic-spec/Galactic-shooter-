/**
 * Surface recipes — the game's entire texture library, as maths.
 *
 * Each entry is a GLSL `surface()` implementation. The rule followed throughout:
 * derive roughness and AO *from the same height/cavity field* that drives the
 * albedo. Crevices are darker AND rougher; raised edges are lighter AND
 * smoother. That single correlation is most of what separates a believable
 * material from a noise texture tinted a colour.
 */
import type { SurfaceKind } from '@/types';

export interface SurfaceRecipe {
  /** GLSL defining `void surface(vec2, out vec3, out float, out float, out float, out float)`. */
  glsl: string;
  /** Height-to-normal strength. */
  normalScale: number;
  /** Default UV repeats per metre of world surface. */
  repeat: number;
  /** Multiplied into the baked albedo; lets one recipe serve tinted variants. */
  tint?: number;
  metalness?: number;
  roughness?: number;
  envMapIntensity?: number;
}

/** Named materials beyond the raw SurfaceKind set. */
export type NamedMaterial =
  | 'fedHull'
  | 'fedPanel'
  | 'fedGlass'
  | 'fedTrim'
  | 'nordicIronwork'
  | 'greyAlloy'
  | 'mantisResin'
  | 'hiveChitin'
  | 'reptilianStone'
  | 'obsidian'
  | 'rustedSteel'
  | 'crystal';

export type SurfaceMaterialName = SurfaceKind | NamedMaterial;

// ---------------------------------------------------------------------------
// Recipes
// ---------------------------------------------------------------------------

const ROCK = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 6.0;
  // Strata: compressed layers running roughly horizontally, warped so they bend.
  vec2 w = p + vec2(pfbm(p*0.55, 6.0, 4, 0.5)*0.9, 0.0);
  float strata = pfbm(vec2(w.x*0.35, w.y*3.2), 6.0, 3, 0.55);
  float bands = sin(w.y*7.0 + strata*4.5);
  float layer = smoothstep(-0.35, 0.35, bands);

  // Macro form plus ridged detail gives the chipped, angular read of real stone.
  float macro = pridged(p*0.85, 6.0, 5, 0.52) * 0.55;
  float grain = pfbm(p*7.5, 48.0, 4, 0.5) * 0.12;

  // Worley cracks: F2-F1 is small along cell borders, which is exactly a crack.
  vec3 cw = pworley(p*2.2, 14.0);
  float crack = 1.0 - smoothstep(0.0, 0.13, cw.y - cw.x);
  crack *= 0.75;

  height = macro + grain + layer*0.1 - crack*0.4;

  // Cavity: how far below the local average this point sits.
  float cavity = clamp(0.5 - (macro*0.9 - crack*0.6), 0.0, 1.0);

  // Real dry stone sits around 0.20-0.30 albedo. Authoring it brighter is the
  // single most common reason a PBR scene reads as chalky plastic.
  vec3 dark  = (vec3(0.070, 0.066, 0.062));
  vec3 mid   = (vec3(0.196, 0.180, 0.164));
  vec3 light = (vec3(0.325, 0.301, 0.270));
  vec3 warm  = (vec3(0.254, 0.196, 0.145));

  albedo = mix(mid, light, smoothstep(0.1, 0.7, macro + grain*2.0));
  albedo = mix(albedo, warm, layer*0.32);
  albedo = mix(albedo, dark, cavity*0.75 + crack*0.55);
  // Mineral speckle: sparse bright grains catch the light like quartz.
  float speck = step(0.972, hash21(floor(p*140.0)));
  albedo += speck * 0.10;

  rough = clamp(0.62 + cavity*0.30 + crack*0.12 - speck*0.25, 0.25, 0.99);
  metal = 0.0;
  ao    = clamp(1.0 - cavity*0.62 - crack*0.5, 0.15, 1.0);
}
`;

const SAND = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 8.0;
  // Two ripple systems at different scales and angles: dunes and wind ripples.
  // Wind ripples dominate what you actually see underfoot; the broad dune form is
  // a low-amplitude undulation, not the main texture. Getting that balance wrong
  // is what made this read as polished wood grain.
  float duneA = sin(p.x*0.9 + pfbm(p*0.3, 8.0, 3, 0.5)*3.2);
  float ripple = sin(p.y*13.0 + p.x*2.5 + pfbm(p*1.4, 16.0, 4, 0.55)*7.0);
  float ripple2 = sin(p.y*31.0 + pfbm(p*3.0, 24.0, 3, 0.5)*6.0);
  // Granularity: coarse enough to survive mipmapping at grazing angles.
  float grain = pfbm(p*38.0, 152.0, 4, 0.55);
  float coarse = hash21(floor(p*90.0)) - 0.5;

  height = duneA*0.05 + ripple*0.075 + ripple2*0.03 + grain*0.05 + coarse*0.03;

  float crest = smoothstep(-0.4, 0.7, ripple*0.6 + duneA*0.3);
  vec3 pale = (vec3(0.478, 0.423, 0.325));
  vec3 deep = (vec3(0.258, 0.219, 0.164));
  vec3 grey = (vec3(0.317, 0.305, 0.290));
  albedo = mix(deep, pale, crest*0.75 + grain*0.35 + 0.2);
  albedo = mix(albedo, grey, smoothstep(0.3,0.9,pfbm(p*0.3,8.0,3,0.5)+0.5)*0.2);
  albedo += coarse * 0.045;

  // Uniformly rough: sand has no gloss anywhere, and any variation reads as wet.
  rough = clamp(0.93 + grain*0.04, 0.85, 1.0);
  metal = 0.0;
  ao    = clamp(0.82 + crest*0.18 - abs(ripple2)*0.08, 0.45, 1.0);
}
`;

const ICE = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 5.0;
  // Fracture planes: straight-ish conchoidal breaks, not blobby noise.
  vec3 cw = pworley(p*1.6, 8.0);
  float plane = smoothstep(0.0, 0.30, cw.y - cw.x);
  float fractureEdge = 1.0 - plane;

  // Sub-surface texture: trapped bubbles and flow banding deep in the ice.
  float bubbles = smoothstep(0.62, 0.95, pworley(p*7.0, 35.0).x);
  float banding = pfbm(vec2(p.x*0.5, p.y*2.6), 8.0, 4, 0.55);
  float frost = pfbm(p*24.0, 120.0, 4, 0.55);

  height = fractureEdge*(-0.28) + banding*0.05 + frost*0.03 + bubbles*0.04;

  // Ice is not white. Its colour comes from depth-dependent blue absorption, so
  // the body stays saturated and only the frosted/bubbled parts go pale.
  vec3 deepBlue = (vec3(0.098, 0.278, 0.407));
  vec3 midBlue  = (vec3(0.352, 0.596, 0.717));
  albedo = mix(deepBlue, midBlue, smoothstep(-0.4,0.6,banding));
  albedo = mix(albedo, (vec3(0.741, 0.850, 0.898)), bubbles*0.55 + frost*0.3);
  // Fracture faces catch light: brighter, and much smoother than the frosted body.
  albedo = mix(albedo, vec3(0.83, 0.90, 0.94), fractureEdge*0.30);

  rough = clamp(0.30 - fractureEdge*0.22 + frost*0.30 + bubbles*0.15, 0.03, 0.75);
  metal = 0.0;
  ao    = clamp(1.0 - fractureEdge*0.30, 0.45, 1.0);
}
`;

const METAL = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  // Panel layout: a grid with per-cell offset so seams aren't a perfect lattice.
  vec2 cell = floor(p * 4.0);
  float cellRand = hash21(cell);
  vec2 f = fract(p * 4.0);
  float seam = min(min(f.x, 1.0-f.x), min(f.y, 1.0-f.y));
  float seamMask = 1.0 - smoothstep(0.0, 0.035, seam);

  // Brushed grain runs along the panel's own axis, alternating per cell.
  float dir = step(0.5, cellRand);
  vec2 bp = mix(p.xy, p.yx, dir);
  float brushed = brushedGrain(bp, 240.0, 6.0);

  // Rivets around the panel border.
  vec2 rp = abs(f - 0.5);
  float ring = smoothstep(0.44, 0.46, max(rp.x, rp.y));
  vec2 rivetGrid = fract(p * 32.0) - 0.5;
  float rivet = (1.0 - smoothstep(0.14, 0.22, length(rivetGrid))) * ring;

  // Edge wear: the corners and seams lose their coating first.
  float wear = smoothstep(0.25, 0.9, seamMask + rivet*0.6 + scratches(p*3.0, 26.0, 0.06)*0.7);
  float grime = smoothstep(0.35, 0.95, pfbm(p*7.0, 28.0, 5, 0.55) + seamMask*0.5);

  height = -seamMask*0.5 + rivet*0.45 + brushed*0.035 + (cellRand-0.5)*0.02;

  vec3 paint = (vec3(0.180, 0.207, 0.231));
  vec3 bare  = (vec3(0.529, 0.556, 0.584));
  vec3 dirt  = (vec3(0.117, 0.109, 0.098));
  albedo = mix(paint, bare, wear);
  albedo *= 0.96 + brushed*0.07;
  albedo = mix(albedo, dirt, grime*0.45 + seamMask*0.3);

  // Worn-through metal is smoother and fully metallic; paint is rougher and less so.
  rough = clamp(mix(0.55, 0.22, wear) + grime*0.28 - brushed*0.06, 0.08, 0.95);
  metal = clamp(mix(0.62, 1.0, wear) - grime*0.35, 0.0, 1.0);
  ao    = clamp(1.0 - seamMask*0.55 - grime*0.25, 0.25, 1.0);
}
`;

const CONCRETE = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 4.0;
  // Aggregate: exposed stones of varying size sitting in a cement matrix.
  vec4 v1 = voronoi(p*9.0);
  vec4 v2 = voronoi(p*20.0 + 13.0);
  float agg = smoothstep(0.34, 0.06, v1.x)*0.7 + smoothstep(0.22, 0.04, v2.x)*0.3;
  float matrix = pfbm(p*16.0, 64.0, 4, 0.5);

  // Formwork: horizontal board seams from the mould.
  float board = smoothstep(0.02, 0.0, abs(fract(p.y*0.75) - 0.5) - 0.47);
  // Water staining runs downward from the seams.
  float stain = smoothstep(0.2, 0.9, pfbm(vec2(p.x*3.0, p.y*0.5), 16.0, 4, 0.6));
  float chip = smoothstep(0.55, 0.85, pworley(p*3.0, 12.0).x) * step(0.7, hash21(floor(p*3.0)));

  height = agg*0.12 + matrix*0.05 - board*0.3 - chip*0.35;

  vec3 cement = (vec3(0.341, 0.336, 0.321));
  vec3 dark   = (vec3(0.117, 0.117, 0.113));
  vec3 stoneA = (vec3(0.243, 0.223, 0.200));
  albedo = mix(cement, stoneA, agg*0.6);
  albedo *= 0.9 + matrix*0.2;
  albedo = mix(albedo, dark, stain*0.35 + board*0.4 + chip*0.3);

  rough = clamp(0.88 - agg*0.12 + stain*0.06, 0.55, 1.0);
  metal = 0.0;
  ao    = clamp(1.0 - board*0.5 - chip*0.4 - agg*0.1, 0.3, 1.0);
}
`;

const CHITIN = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 3.0;
  // Overlapping plates: a scalloped lattice, offset row to row.
  vec2 g = vec2(p.x*4.0, p.y*7.0);
  float row = floor(g.y);
  g.x += mod(row, 2.0)*0.5;
  vec2 cf = fract(g) - 0.5;
  float plate = 1.0 - smoothstep(0.24, 0.5, length(cf*vec2(1.0, 1.5)));
  float plateEdge = smoothstep(0.30, 0.48, length(cf*vec2(1.0,1.5)));

  float pore = smoothstep(0.75, 0.95, pworley(p*22.0, 66.0).x);
  float ridgeDetail = pfbm(p*18.0, 54.0, 3, 0.5);

  height = plate*0.32 - plateEdge*0.2 + ridgeDetail*0.04 - pore*0.05;

  // Lifted off near-black: chitin needs enough value range for the plate edges
  // to read at all, or the whole creature becomes an unlit silhouette.
  vec3 base = (vec3(0.290, 0.203, 0.129));
  vec3 warm = (vec3(0.662, 0.435, 0.180));
  albedo = mix(base, warm, plate*0.7 + ridgeDetail*0.2);
  // Thin-film iridescence: the hue shifts with the plate's local slope, which is
  // what makes insect shell read as shell rather than brown plastic.
  float shift = plate*0.8 + ridgeDetail*0.5;
  vec3 irid = hsv2rgb(vec3(fract(0.36 + shift*0.30), 0.55, 1.0));
  albedo = mix(albedo, albedo*0.5 + irid*0.5, 0.24 + plateEdge*0.16);
  albedo = mix(albedo, base*0.5, pore*0.4);

  // Waxy: quite smooth on the plate faces, rougher in the seams.
  rough = clamp(0.28 + plateEdge*0.42 + pore*0.2, 0.14, 0.9);
  metal = 0.06;
  ao    = clamp(1.0 - plateEdge*0.6 - pore*0.25, 0.2, 1.0);
}
`;

const ORGANIC = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 4.0;
  // Vein network: worley borders make a branching capillary structure.
  vec3 w1 = pworley(p*3.0, 12.0);
  float vein = 1.0 - smoothstep(0.0, 0.10, w1.y - w1.x);
  vec3 w2 = pworley(p*8.0, 32.0);
  float capillary = (1.0 - smoothstep(0.0, 0.06, w2.y - w2.x)) * 0.5;
  float flesh = pfbm(p*6.0, 24.0, 5, 0.55);
  float pore = smoothstep(0.8, 0.98, pworley(p*30.0, 120.0).x);

  height = vein*0.22 + capillary*0.1 + flesh*0.06 - pore*0.08;

  vec3 deep = (vec3(0.117, 0.054, 0.050));
  vec3 mid  = (vec3(0.247, 0.141, 0.129));
  vec3 pale = (vec3(0.372, 0.254, 0.223));
  albedo = mix(deep, mid, smoothstep(-0.3, 0.5, flesh));
  albedo = mix(albedo, pale, vein*0.45);
  albedo = mix(albedo, deep*0.6, pore*0.5);

  // Wet: low roughness everywhere, lowest on the raised veins.
  rough = clamp(0.34 - vein*0.16 + pore*0.2, 0.1, 0.7);
  metal = 0.0;
  ao    = clamp(1.0 - pore*0.4 - (1.0-vein)*0.15, 0.35, 1.0);
}
`;

const FOLIAGE = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  // A leaf blade shape in UV so alpha-tested cards read as real leaves.
  float mid = abs(p.x - 0.5);
  float taper = smoothstep(0.0, 0.14, p.y) * (1.0 - smoothstep(0.62, 1.0, p.y));
  float blade = 1.0 - smoothstep(0.06 + taper*0.30, 0.10 + taper*0.34, mid);

  float midrib = 1.0 - smoothstep(0.0, 0.016, mid);
  // Secondary veins fan out from the midrib at an angle.
  float vein = smoothstep(0.55, 1.0, abs(sin((p.y*26.0 + mid*30.0))))*0.5;
  float mottle = pfbm(p*vec2(7.0, 4.0), 24.0, 4, 0.55);

  height = midrib*0.3 + vein*0.08 + mottle*0.05;

  vec3 dark  = (vec3(0.043, 0.098, 0.035));
  vec3 green = (vec3(0.129, 0.239, 0.078));
  vec3 acid  = (vec3(0.352, 0.474, 0.113));
  albedo = mix(dark, green, smoothstep(-0.4, 0.5, mottle));
  // Tip lightening: new growth at the blade end is more yellow.
  albedo = mix(albedo, acid, smoothstep(0.45, 1.0, p.y)*0.55);
  albedo = mix(albedo, acid*1.1, midrib*0.3);
  albedo *= 0.85 + blade*0.15;

  rough = clamp(0.62 + mottle*0.15 - midrib*0.1, 0.35, 0.95);
  metal = 0.0;
  ao    = clamp(0.7 + blade*0.3 - vein*0.1, 0.3, 1.0);
}
`;

const GLASS = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 2.0;
  // Surface imperfection only — the transparency comes from the material, not here.
  float smudge = pfbm(p*5.0, 20.0, 4, 0.6);
  float micro  = pfbm(p*60.0, 240.0, 3, 0.5);
  float scratch = scratches(p*2.0, 40.0, 0.03);

  height = micro*0.01 + scratch*0.04;
  albedo = (vec3(0.686, 0.792, 0.847)) * (0.95 + smudge*0.08);
  rough = clamp(0.04 + smoothstep(0.2,0.9,smudge)*0.16 + scratch*0.35, 0.02, 0.6);
  metal = 0.0;
  ao    = 1.0;
}
`;

const ENERGY = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  // Hex lattice: fold the plane into a hex grid and take the distance to the edge.
  vec2 hp = vec2(p.x*1.1547, p.y + mod(floor(p.x*1.1547*10.0), 2.0)*0.05) * 10.0;
  vec2 hf = fract(hp) - 0.5;
  float hex = max(abs(hf.x)*0.866 + abs(hf.y)*0.5, abs(hf.y));
  float grid = 1.0 - smoothstep(0.36, 0.46, hex);
  float edge = smoothstep(0.40, 0.50, hex);
  float scan = smoothstep(0.35, 0.5, abs(fract(p.y*6.0) - 0.5));
  float flow = pfbm(p*4.0, 16.0, 4, 0.6);

  height = grid*0.05;
  vec3 core = (vec3(0.372, 0.894, 1.0));
  albedo = core * (0.25 + edge*1.4 + scan*0.25 + flow*0.2);
  rough = 0.25;
  metal = 0.0;
  ao    = 1.0;
}
`;

const WATER = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 4.0;
  float w1 = pfbm(p*2.0, 8.0, 4, 0.55);
  float w2 = pfbm(p*5.0 + 3.7, 20.0, 4, 0.55);
  float chop = pfbm(p*14.0, 56.0, 3, 0.5);
  height = w1*0.16 + w2*0.08 + chop*0.02;
  albedo = (vec3(0.019, 0.062, 0.094)) * (0.85 + w1*0.3);
  rough = clamp(0.06 + chop*0.08, 0.02, 0.3);
  metal = 0.0;
  ao    = 1.0;
}
`;

const FLESH = ORGANIC;

// -- named / faction materials ----------------------------------------------

const FED_HULL = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  // Federation design language: large chamfered plates, tight seams, cyan trim.
  vec2 cell = floor(p*3.0);
  float r = hash21(cell);
  vec2 f = fract(p*3.0);
  float seam = min(min(f.x,1.0-f.x), min(f.y,1.0-f.y));
  float seamMask = 1.0 - smoothstep(0.0, 0.022, seam);
  // A chamfer band just inside the seam catches light along every panel edge.
  float chamfer = smoothstep(0.022, 0.06, seam) * (1.0 - smoothstep(0.06, 0.1, seam));

  float brushed = brushedGrain(p, 4.0, 260.0);
  float wear = smoothstep(0.4, 1.0, seamMask*0.8 + scratches(p*2.0, 30.0, 0.05)*0.6);
  float grime = smoothstep(0.45, 1.0, pfbm(p*6.0, 24.0, 4, 0.55) + seamMask*0.4);

  // A thin emissive channel runs along one axis of some panels.
  float stripe = (1.0 - smoothstep(0.006, 0.012, abs(f.y - 0.18))) * step(0.62, r);

  height = -seamMask*0.5 + chamfer*0.22 + brushed*0.02;

  vec3 hull = (vec3(0.560, 0.580, 0.600));
  vec3 shade= (vec3(0.207, 0.231, 0.258));
  vec3 bare = (vec3(0.674, 0.694, 0.713));
  albedo = mix(hull, shade, (r*0.35));
  albedo = mix(albedo, bare, wear*0.6 + chamfer*0.35);
  albedo *= 0.975 + brushed*0.05;
  albedo = mix(albedo, (vec3(0.098,0.113,0.129)), grime*0.3 + seamMask*0.35);
  albedo = mix(albedo, (vec3(0.372,0.894,1.0)), stripe*0.9);

  rough = clamp(mix(0.34, 0.18, wear) + grime*0.3 + seamMask*0.2 - stripe*0.1, 0.08, 0.9);
  metal = clamp(0.85 - grime*0.4 + wear*0.15 - stripe*0.7, 0.0, 1.0);
  ao    = clamp(1.0 - seamMask*0.5 - grime*0.2, 0.3, 1.0);
}
`;

const FED_PANEL = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  float grid = 1.0 - smoothstep(0.0, 0.02, min(abs(fract(p.x*8.0)-0.5), abs(fract(p.y*8.0)-0.5)) );
  float vent = step(0.72, hash21(floor(p*8.0)));
  float slats = (1.0 - smoothstep(0.3,0.42, abs(fract(p.y*64.0)-0.5))) * vent;
  float dirt = pfbm(p*9.0, 36.0, 4, 0.55);
  height = -grid*0.28 - slats*0.4 + dirt*0.03;
  vec3 base = (vec3(0.145, 0.168, 0.192));
  albedo = mix(base, (vec3(0.313,0.337,0.364)), smoothstep(-0.2,0.6,dirt));
  albedo = mix(albedo, base*0.3, slats*0.8 + grid*0.5);
  rough = clamp(0.42 + dirt*0.2 + grid*0.2, 0.15, 0.95);
  metal = clamp(0.8 - slats*0.4, 0.0, 1.0);
  ao    = clamp(1.0 - grid*0.4 - slats*0.6, 0.2, 1.0);
}
`;

const FED_TRIM = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  float brushed = brushedGrain(p, 3.0, 300.0);
  float wear = scratches(p*2.0, 36.0, 0.04);
  height = brushed*0.03 + wear*0.02;
  vec3 gold = (vec3(0.780, 0.615, 0.313));
  albedo = gold * (0.94 + brushed*0.09 + wear*0.12);
  rough = clamp(0.24 + brushed*0.12 + wear*0.2, 0.08, 0.6);
  metal = 1.0;
  ao = 1.0;
}
`;

const OBSIDIAN = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv*3.0;
  vec3 w = pworley(p*2.0, 6.0);
  // Conchoidal fracture: broad smooth shells with sharp intersection lines.
  float shell = smoothstep(0.0, 0.5, w.x);
  float edge  = 1.0 - smoothstep(0.0, 0.06, w.y - w.x);
  float flow  = pfbm(p*4.0, 12.0, 4, 0.55);
  height = shell*0.18 - edge*0.35 + flow*0.03;
  vec3 black = (vec3(0.019, 0.019, 0.023));
  vec3 sheen = (vec3(0.062, 0.058, 0.070));
  albedo = mix(black, sheen, shell*0.5 + flow*0.2);
  albedo = mix(albedo, black*0.4, edge*0.6);
  rough = clamp(0.22 + edge*0.4 + flow*0.06, 0.12, 0.7);
  metal = 0.0;
  ao = clamp(1.0 - edge*0.5, 0.4, 1.0);
}
`;

const RUSTED_STEEL = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv*3.0;
  float rustField = smoothstep(0.25, 0.75, pfbm(p*2.2, 8.0, 5, 0.58) + 0.15);
  float scab = smoothstep(0.5, 0.9, pworley(p*9.0, 27.0).x) * rustField;
  float pit  = smoothstep(0.7, 0.95, pworley(p*20.0, 60.0).x) * rustField;
  float brushed = brushedGrain(p, 3.0, 200.0);
  height = -rustField*0.18 - pit*0.3 + scab*0.16 + brushed*0.02;
  vec3 steel = (vec3(0.478, 0.505, 0.529));
  vec3 rust  = (vec3(0.470, 0.223, 0.098));
  vec3 dark  = (vec3(0.180, 0.086, 0.043));
  albedo = mix(steel*(0.9+brushed*0.2), rust, rustField);
  albedo = mix(albedo, dark, pit*0.7 + scab*0.25);
  rough = clamp(mix(0.30, 0.94, rustField) + pit*0.06, 0.15, 1.0);
  metal = clamp(1.0 - rustField*0.85, 0.05, 1.0);
  ao = clamp(1.0 - pit*0.55 - rustField*0.2, 0.25, 1.0);
}
`;

const CRYSTAL = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv*4.0;
  vec3 w = pworley(p*2.4, 10.0);
  // Quantise into discrete flat planes so each cell reads as a cut facet rather
  // than a bulge; the sharp step between them is the crystalline silhouette.
  float facet = floor(w.x * 5.0) / 5.0;
  float edge = 1.0 - smoothstep(0.0, 0.035, w.y - w.x);
  float inner = pfbm(p*7.0, 28.0, 4, 0.6);
  height = facet*0.45 - edge*0.5;
  vec3 tint = hsv2rgb(vec3(fract(0.50 + w.z*0.08), 0.72, 0.62));
  albedo = mix(tint*0.18, tint, facet*0.9 + inner*0.2);
  albedo += edge*0.12;
  rough = clamp(0.06 + edge*0.2, 0.02, 0.4);
  metal = 0.0;
  ao = clamp(1.0 - edge*0.3, 0.5, 1.0);
}
`;

// Faction stone/alloy variants reuse the strongest base recipes with a
// different palette and detail balance, which is how a real art team would do it.
const NORDIC_IRONWORK = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv*2.0;
  // Hammered surface: overlapping shallow dents from forging.
  vec3 w = pworley(p*7.0, 14.0);
  float dent = smoothstep(0.62, 0.10, w.x);
  float frost = smoothstep(0.5, 1.0, pfbm(p*11.0, 22.0, 4, 0.55));
  // Etched runes: sparse angular grooves on a coarse lattice.
  vec2 rg = fract(p*3.0) - 0.5;
  float runeCell = hash21(floor(p*3.0));
  float rune = (1.0 - smoothstep(0.02, 0.05, min(abs(rg.x), abs(rg.y)))) * step(0.68, runeCell);
  rune *= step(0.25, max(abs(rg.x), abs(rg.y))) * (1.0 - step(0.42, max(abs(rg.x), abs(rg.y))));

  height = dent*0.2 - rune*0.4 + frost*0.03;
  vec3 iron = (vec3(0.098, 0.109, 0.129));
  vec3 cold = (vec3(0.223, 0.262, 0.301));
  albedo = mix(iron, cold, dent*0.22 + frost*0.28);
  albedo = mix(albedo, (vec3(0.352, 0.717, 0.901)), rune*0.85);
  rough = clamp(0.46 - dent*0.14 + frost*0.3 - rune*0.2, 0.1, 0.95);
  metal = clamp(0.9 - frost*0.5 - rune*0.6, 0.0, 1.0);
  ao = clamp(1.0 - rune*0.5 - dent*0.15, 0.3, 1.0);
}
`;

const GREY_ALLOY = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv;
  // Deliberately near-featureless: the Greys' tech is seamless and unsettlingly
  // clean, so the material story is *absence* of wear, with faint inlay only.
  // One hairline inlay per large panel, not a stripe pattern — the Greys'
  // surfaces should read as almost unbroken, so the seam has to be rare.
  // inlay is 1 only in the hairline itself; the previous form was inverted and
  // tinted the entire surface violet.
  float inlay = smoothstep(0.4955, 0.4995, abs(fract(p.y*1.5) - 0.5));
  float micro = pfbm(p*90.0, 360.0, 2, 0.5);
  float sheen = pfbm(p*2.0, 8.0, 3, 0.6);
  height = -inlay*0.10 + micro*0.006;
  vec3 white = (vec3(0.705, 0.709, 0.729));
  albedo = white * (0.97 + micro*0.05 + sheen*0.03);
  albedo = mix(albedo, (vec3(0.560, 0.301, 0.898)), inlay*0.85);
  rough = clamp(0.12 + micro*0.05, 0.05, 0.3);
  metal = clamp(0.55 - inlay*0.5, 0.0, 1.0);
  ao = clamp(1.0 - inlay*0.4, 0.6, 1.0);
}
`;

const MANTIS_RESIN = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv*3.0;
  // Secreted resin: layered drips and pooled ridges, glossy where fresh.
  float drip = pfbm(vec2(p.x*4.0, p.y*0.7), 16.0, 5, 0.6);
  float pool = smoothstep(0.2, 0.8, pfbm(p*1.6, 6.0, 4, 0.55));
  float bubble = smoothstep(0.78, 0.96, pworley(p*13.0, 39.0).x);
  height = drip*0.14 + pool*0.1 + bubble*0.06;
  vec3 amber = (vec3(0.435, 0.529, 0.117));
  vec3 dark  = (vec3(0.117, 0.176, 0.070));
  albedo = mix(dark, amber, pool*0.7 + drip*0.4 + 0.2);
  albedo = mix(albedo, (vec3(0.647,0.847,0.239)), bubble*0.45);
  rough = clamp(0.22 + bubble*0.2 - pool*0.08, 0.08, 0.7);
  metal = 0.0;
  ao = clamp(1.0 - bubble*0.25 - (1.0-pool)*0.2, 0.4, 1.0);
}
`;

const HIVE_CHITIN = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv * 3.0;
  vec2 g = vec2(p.x*3.4, p.y*6.0);
  float row = floor(g.y);
  g.x += mod(row, 2.0)*0.5;
  vec2 cf = fract(g) - 0.5;
  float plate = 1.0 - smoothstep(0.22, 0.48, length(cf*vec2(1.0, 1.6)));
  float plateEdge = smoothstep(0.28, 0.46, length(cf*vec2(1.0,1.6)));
  // Spiracles: the glowing breathing pores along the flanks.
  float spiracle = 1.0 - smoothstep(0.05, 0.10, length(cf*vec2(1.0,1.6)));
  float wet = pfbm(p*14.0, 42.0, 4, 0.55);
  float pore = smoothstep(0.78, 0.96, pworley(p*20.0, 60.0).x);

  height = plate*0.34 - plateEdge*0.22 + wet*0.03 - pore*0.05 - spiracle*0.2;

  vec3 dark  = (vec3(0.098, 0.062, 0.031));
  vec3 amber = (vec3(0.352, 0.196, 0.070));
  albedo = mix(dark, amber, plate*0.75 + wet*0.2);
  albedo = mix(albedo, (vec3(0.717, 0.352, 0.086)), spiracle*0.8);
  albedo = mix(albedo, dark*0.5, pore*0.45 + plateEdge*0.3);

  // Wet-looking: low roughness on plate faces, matte in the seams.
  rough = clamp(0.24 + plateEdge*0.5 + pore*0.2 - wet*0.05, 0.10, 0.95);
  metal = 0.0;
  ao    = clamp(1.0 - plateEdge*0.62 - pore*0.3, 0.18, 1.0);
}
`;

const REPTILIAN_STONE = /* glsl */ `
void surface(vec2 uv, out vec3 albedo, out float height, out float rough, out float metal, out float ao){
  vec2 p = uv*4.0;
  // Cooled basalt with heat still in the cracks — the fissure glow is the
  // faction's whole visual identity, so it is a real emissive-ready mask.
  float macro = pridged(p*0.9, 8.0, 5, 0.5);
  vec3 w = pworley(p*2.6, 10.0);
  float crack = 1.0 - smoothstep(0.0, 0.10, w.y - w.x);
  float deepCrack = 1.0 - smoothstep(0.0, 0.04, w.y - w.x);
  float grain = pfbm(p*9.0, 36.0, 4, 0.5);
  float vesicle = smoothstep(0.72, 0.94, pworley(p*18.0, 72.0).x);

  height = macro*0.4 + grain*0.06 - crack*0.5 - vesicle*0.1;
  vec3 basalt = (vec3(0.043, 0.039, 0.039));
  vec3 ash    = (vec3(0.141, 0.129, 0.125));
  vec3 ember  = (vec3(0.980, 0.352, 0.078));
  albedo = mix(basalt, ash, smoothstep(0.0,0.7,macro+grain));
  albedo = mix(albedo, basalt*0.4, vesicle*0.6);
  // Heat glow concentrated in the deepest fissures only.
  albedo = mix(albedo, ember, deepCrack*0.9);
  rough = clamp(0.82 - deepCrack*0.3 + vesicle*0.15, 0.3, 1.0);
  metal = 0.0;
  ao = clamp(1.0 - crack*0.5 - vesicle*0.3, 0.2, 1.0);
}
`;

// ---------------------------------------------------------------------------

export const SURFACE_RECIPES: Record<SurfaceMaterialName, SurfaceRecipe> = {
  rock: { glsl: ROCK, normalScale: 1.5, repeat: 1, roughness: 1, metalness: 0 },
  sand: { glsl: SAND, normalScale: 0.9, repeat: 1.4, roughness: 1, metalness: 0 },
  ice: { glsl: ICE, normalScale: 1.2, repeat: 1, roughness: 1, metalness: 0, envMapIntensity: 1.6 },
  metal: { glsl: METAL, normalScale: 1.4, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.3 },
  concrete: { glsl: CONCRETE, normalScale: 1.3, repeat: 1, roughness: 1, metalness: 0 },
  chitin: { glsl: CHITIN, normalScale: 1.6, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.2 },
  organic: { glsl: ORGANIC, normalScale: 1.3, repeat: 1, roughness: 1, metalness: 0 },
  flesh: { glsl: FLESH, normalScale: 1.2, repeat: 1, roughness: 1, metalness: 0 },
  glass: { glsl: GLASS, normalScale: 0.4, repeat: 1, roughness: 1, metalness: 0, envMapIntensity: 2 },
  energy: { glsl: ENERGY, normalScale: 0.5, repeat: 1, roughness: 1, metalness: 0 },
  water: { glsl: WATER, normalScale: 1, repeat: 1, roughness: 1, metalness: 0, envMapIntensity: 2 },
  foliage: { glsl: FOLIAGE, normalScale: 1, repeat: 1, roughness: 1, metalness: 0 },
  fedHull: { glsl: FED_HULL, normalScale: 1.5, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.4 },
  fedPanel: { glsl: FED_PANEL, normalScale: 1.4, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.2 },
  fedGlass: { glsl: GLASS, normalScale: 0.4, repeat: 1, roughness: 1, metalness: 0, envMapIntensity: 2.2 },
  fedTrim: { glsl: FED_TRIM, normalScale: 0.8, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.6 },
  nordicIronwork: { glsl: NORDIC_IRONWORK, normalScale: 1.5, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.3 },
  greyAlloy: { glsl: GREY_ALLOY, normalScale: 0.7, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.8 },
  mantisResin: { glsl: MANTIS_RESIN, normalScale: 1.3, repeat: 1, roughness: 1, metalness: 0, envMapIntensity: 1.3 },
  hiveChitin: { glsl: HIVE_CHITIN, normalScale: 1.6, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.2 },
  reptilianStone: { glsl: REPTILIAN_STONE, normalScale: 1.7, repeat: 1, roughness: 1, metalness: 0 },
  obsidian: { glsl: OBSIDIAN, normalScale: 1.5, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.7 },
  rustedSteel: { glsl: RUSTED_STEEL, normalScale: 1.5, repeat: 1, roughness: 1, metalness: 1, envMapIntensity: 1.1 },
  crystal: { glsl: CRYSTAL, normalScale: 1.4, repeat: 1, roughness: 1, metalness: 0, envMapIntensity: 2 },
};

export const SURFACE_NAMES = Object.keys(SURFACE_RECIPES) as SurfaceMaterialName[];
