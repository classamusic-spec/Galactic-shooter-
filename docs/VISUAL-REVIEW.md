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
- Shoot at the `high` tier for review. `ultra` may not complete a frame in time.

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

- **Cliff silhouettes read as slabs.** `CliffKit` faces have straight top edges
  and flat vertical planes, so on a snow world they read as dark geometric
  primitives punched into the terrain rather than carved rock. Their material
  and normals are correct (verified: the recolour chains `applyUvScale`'s
  `onBeforeCompile` properly and the tint maths matches the terrain layers) — the
  problem is the generated *geometry*. Fix by breaking the top edge with noise,
  varying the face plane per-column, and capping with the snow layer.
- **Clouds read as flat lens-shaped blobs**, not volumetric. The raymarched path
  needs more erosion octaves and a real Beer-Powder term.
- **Aurora not visible on Aurvangr** despite `auroraStrength: 1`. Either the
  curtain is below the horizon at this sun angle or additive blending is being
  lost against the bright sky.
- **Terrain macro-silhouette is rounded** — ridges read closer to dunes than to
  mountains. Raise `ridgePower` and reduce erosion smoothing.
