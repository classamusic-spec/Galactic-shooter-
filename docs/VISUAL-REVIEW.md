# Visual Review Rubric

The gate a build must pass before it is called finished. Reviewers score from
**screenshots only** — never from reading the code, never from the author's
description. If it isn't visible in the frame, it doesn't count.

## How to review

1. Capture with `node tools/critic/shoot.mjs --out shots/<run> --shots <scenarios>`.
2. Open every PNG and actually look at it.
3. Score each axis below **0–10**. Write the specific pixel-level reason for any
   score under 9. "Looks flat" is not a finding; "the entire midground sits in a
   single value band around 45% grey, so the silhouette of the ridge reads as a
   sticker" is a finding.
4. Any axis under 8 **fails the gate**. Report the fix, don't soften the score.

## Reviewer stance

You are reviewing against shipped AAA console/PC output — Destiny 2 specifically.
That is a brutal bar and you should apply it brutally. Assume the author is
capable of much better and that flattering them wastes everyone's time. A 7 that
comes with a precise diagnosis is worth more than a 9 that comes with praise.

**Do not grade on a curve for the platform.** "Good for a browser game" is not a
passing score. Either the frame holds up next to a AAA frame or it doesn't.

## The axes

| # | Axis | What a 10 looks like |
|---|---|---|
| 1 | **Value structure** | A clear dark/mid/light hierarchy. Foreground frames darker than midground, distance lifts into atmosphere. You could convert to greyscale and still read depth instantly. |
| 2 | **Silhouette & shape** | Every enemy, weapon and prop is identifiable as a black shape. Sharp, intentional, varied edges. No lumps, no mushy blobs, no untextured primitives. |
| 3 | **Material believability** | Metal reads metal — coloured specular, environment reflection, roughness variation, edge wear. Rock reads rock — grain, cavity darkening, crevice roughness. Nothing looks like plastic or like flat vertex colour. |
| 4 | **Lighting** | One committed dominant light with real directional shadows, plus coloured sky fill and rim/backlight separating characters from the background. Shadows have correct softness and contact darkening. |
| 5 | **Atmosphere & depth** | Aerial perspective, height fog, light shafts, particulate in the air. Distance genuinely recedes. This is the single biggest "expensive vs cheap" tell. |
| 6 | **Composition** | Framing elements at the edges, leading lines to the objective, a landmark on the horizon, and a clear focal point. Not a camera dropped in the middle of a field. |
| 7 | **Colour & grade** | A committed palette per world with a dominant hue and a complementary accent. Highlights don't clip to white, shadows aren't crushed to black, skin/emissives sit where intended. |
| 8 | **Post-process restraint** | Bloom only on genuine emissives. Grain, vignette and aberration present but subtle. No haze wash, no oversharpen halo, no TAA smear or ghost trails. |
| 9 | **Enemy & character design** | Reads as a designed creature, not assembled primitives. Correct anatomy for its gait, consistent armour language, faction colour identity, believable scale. |
| 10 | **UI craft** | Aligned to a grid, consistent stroke weights and corner treatment, legible over both bright sky and dark cave, animated in and out, no default browser styling. |
| 11 | **VFX quality** | Effects are sequences with flash/core/smoke/debris stages, correctly blended, soft against geometry, HDR-bright at the core. Not sprites-on-quads. |
| 12 | **Technical cleanliness** | No z-fighting, no shadow acne or peter-panning, no visible LOD pop, no texture tiling that reads as repetition, no seams, no aliasing crawl, no NaN pixels. |

## Automatic failures

Regardless of the rest of the frame, any of these fails the gate outright:

- A default `MeshBasicMaterial` / untextured grey primitive visible anywhere.
- A flat single-colour sky, or a visible sky-dome seam.
- Enemies in a T-pose, with detached/inverted limbs, or sliding feet.
- The whole frame in one value band (no dark, or no light).
- Bloom washing out more than ~15% of the frame.
- Visible tiling repetition in a ground texture within the first 20 m.
- A HUD element clipped, overlapping, or misaligned to the rest of the grid.
- Any WebGL error or uncaught exception in `report.json`.
- Sub-45 fps at the `high` tier on the reference capture size.

## Side-by-side protocol

When comparing against a Destiny 2 reference frame:

1. Match the shots for **content**, not just mood — same rough scene type (interior
   corridor, open vista, boss arena, close-quarters firefight).
2. Compare **one axis at a time** from the table above. Global "which is better"
   judgements hide the actionable gap.
3. Report the gap per axis in plain terms, and name the *cheapest* change that
   would close the largest gap. Usually it is lighting or atmosphere, not
   geometry density.
4. State honestly which frame you'd pick and why. Do not claim parity that isn't
   there — a false pass wastes the next iteration.

## Capture environment — read before trusting any number

Headless Chromium here runs **ANGLE over SwiftShader**, a *software* rasteriser.
Confirmed capabilities: WebGL2, 6 draw buffers (MRT works), `EXT_color_buffer_float`,
`EXT_float_blend`, anisotropic filtering, max texture 8192, max samples 4.

Consequences you must account for:

- **FPS from a capture is meaningless.** SwiftShader is 20–100× slower than a real
  GPU and is fill-rate bound, so a heavy post chain tanks it. Never fail a build on
  captured fps, and never "optimise" based on it.
- **Use the static budgets instead** — they are hardware-independent.
- Captures are slow. Allow 10–30 s of settle time before shooting, and prefer
  **1600×900** for iteration, 1920×1080 only for final review shots.
- Shoot at the **medium** tier for iteration. In practice `high` also fails to
  finish a capture inside a 480 s budget once terrain density, 1024 px material
  bakes, 16-sample SSAO and TAA are all on, so `high` and `ultra` currently have
  no working capture path here. Medium is the honest review tier, with the
  caveat that it has TAA off and therefore shows silhouette aliasing that a real
  high-tier build would not.

## Performance gate

Hardware-independent, from `report.json` at the `high` tier:

- Draw calls **< 900**.
- Triangles **< 4.5 M**.
- Shader programs **< 220** (program count is a real stutter source on first sight).
- Zero page errors, zero WebGL errors.
- Boot to first playable frame **< 4 s** on a real GPU — measure by instrumenting
  the boot sequence, not by wall-clock under SwiftShader.

Frame-rate is validated separately by reasoning about the budgets: per-frame
work must stay within the draw-call and triangle limits above, particle and enemy
counts must respect `settings.profile`, and no system may allocate in its update
loop. If those hold, the build performs on real hardware.

---

## Known defects (open)

Recorded from real capture review so they are not rediscovered:

- ~~**Cliff silhouettes read as slabs.**~~ FIXED. The face generation already had
  fluting, strata ledges and overhang; the giveaway was the crest line following
  the terrain smoothly. Now broken with a jag term plus occasional deep clefts,
  both faded out at the ends so the face stays watertight, at 23x11 resolution
  instead of 13x9.
- ~~**Faint dotted outline along distant ridge tops.**~~ FIXED. It is **not**
  aliasing, and it is not the sharpen pass either — both diagnoses were wrong and
  both were disproved by capture rather than by argument:
  - *Not aliasing.* Measured on a real Zeta Reticuli capture, column x=225: sky
    L=145, fringe L=119, terrain L=149. A fringe darker than **both** of its
    neighbours cannot be a stair-step; interpolation between two values can only
    ever land between them.
  - *Not CAS sharpen undershoot.* Forcing `uSharpen` to zero and re-shooting the
    same frames leaves the ridge dashes and Khepri's black specks exactly as they
    were.
  - *It is the SSAO term.* Forcing the composite's AO block off makes the dashed
    line along Zeta's ridge vanish completely and removes most of Khepri's specks.
    GTAO runs at half resolution and takes its shading normal from a depth
    gradient; a depth gradient across a silhouette is not a normal, it points
    along the step, so the integral built on it reports heavy occlusion. That
    texel's depth then agrees with nothing nearby, so the bilateral blur and the
    depth-aware upsample both preserve the bad value instead of filtering it out —
    and at half resolution it lands two full-res pixels wide, which is why the
    specks read as detached from the geometry that caused them.

  Fixed in three places, all measured: `CompositePass` fades the AO term out
  across any depth discontinuity (four depth taps two texels out, shared with the
  sharpen gate); `SsaoPass` applies the same guard at source and despeckles the
  blur by lifting any texel darker than all eight of its neighbours; and the
  sharpen — which was innocent of this but *was* over-driven — is now clamped in
  the pass at 0.18, clamped to its own tap neighbourhood so it cannot over- or
  undershoot at all, faded out with distance and switched off on sky pixels and
  silhouettes. What is left on Khepri is a handful of single dark pixels on
  alpha-tested leaf edges, which is a foliage alpha/mip problem in
  `src/gfx/terrain/FoliageKit.ts`, not a post-processing one.
- ~~**Clouds read as flat blobs.**~~ NOT A BUG — misdiagnosed by judging them on
  the wrong world. `CloudLayer` is a real raymarched volume with shape/erosion
  octaves and Beer-Powder lighting; Aurvangr's profile simply specifies *thin high
  cirrus*, which is what it correctly renders. Hive Prime shows heavy cloud with
  full internal structure.
- ~~**Aurora not visible on Aurvangr.**~~ NOT A BUG. It renders correctly; it was
  simply washed out because the capture faced the bright twilight sun. Looking
  away (`?yaw=170`) shows the green curtains clearly. Additive layers against a
  bright sky are supposed to disappear — review shots for the ice world should
  face away from the sun.
- **Terrain macro-silhouette is rounded** — ridges read closer to dunes than to
  mountains. Raise `ridgePower` and reduce erosion smoothing.
- **Khepri crushes to near-black.** MOSTLY FIXED by the key/fill rebalance in
  `SkyDome` (see below): mean luminance 76.2 -> 85.8, pixels below L=51 29.3% ->
  17.4%, and the trees now separate from the hillside. What is left is the layer
  albedos themselves, which are still dark for a daylit jungle floor. Also still
  open: the organic layer's vein network reads as a visible repeating swirl at
  mid distance, so its `tileMetres` is too large.
- **A world's fill must never outgun its key.** Recorded because it caused the
  "nothing casts a shadow" review and is easy to reintroduce. `SkyDome` now
  enforces a minimum key:fill ratio *measured on a horizontal surface*, i.e.
  including the sun's cosine — Aurvangr's 6.5 degree sun meant a nominal
  intensity of 0.775 delivered 0.088 to the ground against a 0.95 hemisphere
  fill, so a perfect shadow removed under a tenth of the light and no reviewer
  could see it. The rebalance moves energy from fill to key while holding the
  total on a horizontal surface constant, so it never changes a world's exposure.
- **Aurvangr's cast shadows still fall out of frame.** The lighting is now right
  (the props self-shadow correctly and the terrain takes shadow), but the level's
  `spawnFacing: 'away'` puts the sun 122 degrees off the view direction, and a
  6.5 degree sun throws a 38 m monolith's shadow 330 m — behind the caster and
  past the readable ground. That is composition, not lighting: the shot needs
  casters *between* the sun and the near ground, or a cross-lit spawn heading.

## Capture artifacts that are NOT bugs

- **Toasts appear frozen on screen in planet captures.** `UiRoot.render` clamps
  its delta with `Math.min(ctx.frameDt, 0.1)` so a single long frame cannot jump
  an animation. Captures run at ~4 fps under SwiftShader, i.e. 250 ms frames, so
  UI time advances at roughly 40% of wall clock and a 5 s toast outlives a 9 s
  capture. At 60 fps the clamp never engages. Do not "fix" this.

## Per-world review status

All five terrain recipes and atmospheres have been captured and reviewed at least
once. Aurvangr, Zeta Reticuli, Hive Prime and Draco IX pass; Khepri does not yet
(see above). Zeta Reticuli is currently the strongest frame: committed violet
near-black sky, pale dunes carrying the light, obsidian strata framing the left
edge, and genuine value separation front to back.
