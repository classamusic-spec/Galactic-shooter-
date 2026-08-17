# Galactic Federation — Architecture Contract

**Read this before writing a line of code.** Every subsystem is built by a
different author working in parallel. The only thing keeping that from
collapsing is strict file ownership and stable interfaces.

---

## Non-negotiables

1. **No external asset downloads.** No CDN fetches, no `.glb`/`.hdr`/`.png`
   files pulled at runtime, no font CDNs. Everything — textures, normal maps,
   roughness maps, meshes, skies, audio — is **generated procedurally in code**.
   This is a hard constraint of the target environment. It is also why the game
   loads in under a second. Build texture data with `DataTexture`/`CanvasTexture`
   /render-to-target, meshes with `BufferGeometry` maths, audio with WebAudio
   synthesis.
2. **TypeScript strict mode passes.** `npm run typecheck` must be clean.
   No `any` without a comment justifying it. No `@ts-ignore`.
3. **Own only your files.** Listed below. Never edit another owner's file — if
   you need a change there, note it in your final report instead.
4. **Everything imports from `@/types`** for shared contracts and
   `@/util/math` for maths. Do not redefine `clamp`, `lerp`, `damp`, `Rng`.
5. **Zero per-frame allocation in hot paths.** Reuse vectors. `@/util/math`
   exports a `scratch` pool. Object pools for projectiles, particles, decals,
   damage numbers.
6. **Dispose properly.** Every `BufferGeometry`, `Material`, `Texture` and
   `RenderTarget` you create must be released in a `dispose()`.
7. **Respect the quality tier.** Read `settings.profile` (see
   `@/core/Settings`) — never hardcode shadow sizes, sample counts, particle
   counts or texture resolutions.

## Coordinate & unit conventions

- **1 unit = 1 metre.** Player eye height 1.7 m, crouched 1.05 m.
- **Y is up.** Levels are built on the XZ plane.
- **Gravity is 24 m/s²** (Destiny-like: heavier than real, snappier arcs).
  Exported as `GRAVITY` from `@/gameplay/Physics`.
- Angles are **radians** everywhere except user-facing settings (degrees).
- Camera rotation order is `YXZ`; yaw on Y, pitch on X, roll on Z for feel only.

## The frame

`Engine` (`@/core/Engine`) runs a **fixed 120 Hz simulation** with a variable
render. Two hooks:

```ts
interface EngineSystem {
  readonly name: string;
  update?(ctx: FrameContext): void;        // fixed step, ctx.dt === 1/120
  render?(ctx: FrameContext, alpha: number): void; // once per frame
  dispose?(): void;
}
```

Put **gameplay** in `update` (deterministic cadence) and **visual smoothing** in
`render` (camera lerps, view-model sway, UI). `engine.add(system)` registers.

## Render pipeline

`engine.renderPipeline` is a function the PostFX owner installs:

```ts
(scene: THREE.Scene, camera: THREE.Camera, frameDt: number) => void
```

When null, the engine falls back to `renderer.render(scene, camera)`. This is
the single seam between the game and the post-processing chain.

## Levels

A `Level` (see `@/types`) owns a `THREE.Scene` and a `CollisionWorld`. The
engine holds exactly one active level. `load()` may be async and should report
progress. Levels expose `sunDirection`, `sunColor`, `fogColor` so post-processing
can do god rays and atmospheric fog correctly.

## Collision

`CollisionWorld` (see `@/types`) is the only physics interface gameplay may
use. Implementation lives in `@/gameplay/Physics` (BVH-backed) — levels build
one and hand it over. Character movement is capsule-vs-triangle with
penetration resolution, not rigid-body dynamics.

## Events

`@/core/EventBus` exports a typed `events` singleton. UI, audio and VFX are
**subscribers** — they never poll gameplay state. Gameplay **emits** and never
imports UI. This keeps the dependency graph acyclic:

```
types ← util ← core ← gfx ← gameplay ← world
                 ↖──────── ui (subscribes to events only)
```

## Debug / capture hooks (required)

`Game` installs `window.GF.debug` with:

```ts
{
  scenario(name: string): Promise<void>;  // drive the game to a named state
  scenarios: string[];                    // the catalogue
  setTier(t: QualityTier): void;
  freeze(on: boolean): void;
}
```

The automated visual critic (`tools/critic/shoot.mjs`) drives these. If you add
a level or a set-piece worth looking at, **register a scenario for it**.

---

## File ownership

| Area | Owner files | Exports that others depend on |
|---|---|---|
| Types | `src/types.ts` | all shared interfaces |
| Maths | `src/util/*.ts` | `clamp lerp damp dampVec3 Rng scratch coneDirection rangeFalloff` |
| Engine core | `src/core/{Engine,Renderer,Input,Settings,EventBus,Game}.ts` | `Engine settings events InputSystem` |
| Post-processing | `src/gfx/PostFX.ts`, `src/gfx/passes/**` | `PostFX` class, installs `engine.renderPipeline` |
| Materials/textures | `src/gfx/materials/**` | `MaterialLibrary`, `proceduralTexture()` helpers |
| Sky/atmosphere | `src/gfx/sky/**` | `SkyDome`, `AtmosphereProfile` |
| VFX | `src/gfx/vfx/**` | `VfxSystem` (particles, tracers, impacts, decals, explosions) |
| Terrain | `src/gfx/terrain/**` | `TerrainBuilder`, `ScatterSystem` |
| Physics | `src/gameplay/Physics.ts` | `BvhCollisionWorld`, `GRAVITY` |
| Player | `src/gameplay/Player.ts`, `src/gameplay/PlayerCamera.ts` | `Player` |
| Weapons | `src/gameplay/weapons/**` | `WeaponSystem`, `WEAPONS` |
| Abilities | `src/gameplay/abilities/**` | `AbilitySystem`, `ABILITIES` |
| AI core | `src/gameplay/ai/**` | `NavGrid`, `AiDirector`, `Perception`, `SquadBrain` |
| Enemies | `src/gameplay/enemies/**` | `EnemyManager`, `ARCHETYPES`, per-faction builders |
| Damage/loot | `src/gameplay/{Damage,Loot,Progression}.ts` | `DamageResolver`, `LootSystem` |
| Levels | `src/world/**` | `PLANETS`, planet level classes, `Ship`, `StarMap` |
| UI | `src/ui/**` | `UiRoot` |
| Audio | `src/core/Audio.ts`, `src/core/audio/**` | `audio` singleton |

---

## Visual quality bar

Target: **Destiny 2's art direction**, adapted to what a browser can actually
render at 60 fps. What that concretely means, and what reviewers check:

- **Silhouette first.** Every enemy, weapon and prop must be readable as a
  black shape. No mushy blobs, no untextured primitives, no default-grey.
- **Value structure.** Dark foreground frames, mid-tone middle ground, bright
  atmospheric distance. Never a flat-lit scene.
- **Material honesty.** Metal reads metal (low roughness, coloured specular,
  visible environment). Rock reads rock (high roughness, normal-mapped grain,
  cavity AO). No plastic-looking everything.
- **One dominant light + coloured fill.** A hard sun with real shadows, plus
  sky bounce in a complementary hue. Rim/backlight on characters.
- **Atmosphere in every shot.** Height fog, aerial perspective, light shafts,
  dust motes. Depth cues are what make a scene look expensive.
- **Composition.** Framing elements (arches, pillars, wrecks) at the edges.
  Leading lines to the objective. A visible landmark on the horizon.
- **Restraint in post.** Bloom on emissives only, subtle grain, gentle
  vignette, tasteful chromatic aberration at the frame edge. Never a bloom
  wash-out.
- **Emissive language.** Faction colour identity carried by lights and
  emissives: Federation cyan/white, Nordic ice-blue, Grey violet, Mantis
  acid-green, Insectoid amber-orange, Reptilian blood-red.

## Game-feel bar

- Firing is **three layers**: camera kick (fast, recovers), view-model kick
  (slower, springy), crosshair bloom. Plus muzzle flash, shell/tracer, shake.
- Hits give **four** confirmations: hitmarker, damage number, impact VFX,
  audio. Kills add a distinct sound + a bigger marker.
- Movement has **air control, coyote time, jump buffering, slide with
  momentum, and a landing dip**. Sprint has an FOV kick.
- Enemies **telegraph** — a wind-up pose and an audio tell before every attack.
- Everything the player does gets a **response within 80 ms**.
