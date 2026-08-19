# Audio

Three layers, each falling back to the one below it:

1. **Synthesised bank** — ~280 buffers baked at boot from `src/core/audio/*.ts`.
   This is the floor. Everything works with nothing downloaded.
2. **Recorded effects** (`public/sfx/`) — replace a synthesised buffer of the same
   id. Generated with ElevenLabs; see below.
3. **Recorded music** (`public/music/`) — replaces the generated adaptive score
   per world. See `docs/MUSIC-PROMPTS.md`.

A missing, unreachable or unusable file at layer 2 or 3 costs the player nothing
but a different sound. That is deliberate and is worth preserving: audio must
never be the reason a build is broken.

## Recorded effects

### Generating

```sh
export ELEVENLABS_API_KEY=...            # never pass this as an argument
node tools/audio/gen-sfx.mjs             # skips files that already exist
node tools/audio/gen-sfx.mjs --force --ids gun_sidearm_0,melee_swing
```

Prompts live in `tools/audio/sfx-prompts.mjs`. Ids there **must** match the ids
in `src/core/audio/*.ts` exactly, including take counts — `GUN_TAKES` is 4 and
`VOICE_TAKES` is 3, and the runtime picks between takes at random, so a pack that
ships three of four gun takes makes one shot in four sound like a different
weapon.

### Auditing

The generator cannot check its own output. The API returns 200 with a perfectly
valid file that happens to contain near-silence, or a gunshot that only arrives a
fifth of a second in — both only visible once decoded. So:

```sh
npm run build && npx vite preview --port 5233 --outDir dist &
node tools/audio/qa-sfx.mjs --url http://localhost:5233
```

It boots the game and reads `GF.debug.audio().sfxMetrics`, measured on the
buffers that actually ship, and prints a ready-made `--force --ids` line for
whatever failed. Expect to loop generate → audit → regenerate two or three times;
the first pass of this bank had 24 bad files out of 171, including three whole
weapon families that came back near-silent because the prompt asked for a "single
shot" over a one-second window and the model answered with room tone.

**Read the metrics off the engine, never re-derive them.** An earlier audit
computed its own peak and attack and quietly disagreed: it measured channel 0
where the runtime measures the mono downmix, which on a wide-stereo file is a
3 ms attack against a 95 ms one, so the bank "passed" with mush in it.

### What the runtime does to each file

`src/core/audio/SfxPack.ts`, in order:

- **Trims leading silence**, and for ids that must land on the frame they are
  triggered (`gun_`, `explosion_`, `impact_`, `melee_`, `step_`,
  `weapon_dryfire`, `shield_break`) seeks past the *run-up* as well — generated
  effects routinely write a bow being drawn before the release. Latency ends up
  at the 2 ms pre-roll by construction.
- **Rejects near-silence.** A peak under 0.08 is a failed generation, not a quiet
  sound; levelling it to target would multiply its noise floor twentyfold.
- **Matches the peak of the buffer it replaces**, which preserves the bank's
  per-category levelling (0.72 for guns so overlapping shots leave the limiter
  headroom, 0.9 for a super cast, 0.4 for an idle creature murmur) with no table
  to drift out of sync.
- **Downmixes to mono** — everything here is positional and goes through a
  PannerNode, where a stereo source only muddies the image.

### Deliberately still synthesised

- `hitmarker*`, `ui_*` — must land inside one frame of the input that caused
  them, and are a few hundred bytes synthesised.
- `impact_*`, `step_*` — fired many times a second; procedural variation is what
  keeps them from reading as a loop.
- `amb_*`, `*_loop` — must loop seamlessly, which the bake guarantees by folding
  each buffer back on itself. A generated file has no such guarantee.
- `enemyfire_*` — pitch-shifted per archetype at runtime, which needs a source
  that survives transposition.

## Diagnostics

`GF.debug.audio()` returns, among other things:

| Field | Meaning |
|---|---|
| `sfxPack` | `{ loaded, failed, rejected }` for the recorded effects |
| `sfxMetrics` | per-id `{ peak, attackMs }` on the shipped buffers |
| `musicTrack` | `none` / `ambient` / `combat` |
| `musicGains` | live gain of each music voice plus the generated score under them |
| `worstGunAttackMs` | slowest gun attack; see the note below |
| `clipped` | any buffer over full scale — must stay empty |
| `loopSeams` | discontinuity across each loop point, as a ratio; under ~3 is inaudible |

`worstGunAttackMs` measures time to 90 % of peak. For the synthesised bank that
was a latency figure. For recorded guns it is a *shape* figure — latency is fixed
at the pre-roll by the trim — so read it as "does this discharge crack or does it
mush", with about 40 ms as the line.

`GF.debug.setMusicIntensity(v)` forces the combat switch, skipping its dwell and
quiet-release timers.
