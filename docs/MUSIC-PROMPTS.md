# Suno Prompts — Ophiuchus Reach Soundtrack

Background music, one set per level plus the star map. Every prompt is written to
sit **on top of the game's own adaptive score** rather than fight it, so the key
and tempo in each block are not decoration — they are the values the in-engine
`MusicEngine` is already sequencing for that world (`src/core/audio/Music.ts`,
`WORLDS`). Match them and a Suno track will layer cleanly over the live stems;
ignore them and you get two different tonal centres at once.

| Level | Key / mode | BPM | Industrial bias |
|---|---|---|---|
| Star map (orbit) | G aeolian | 66 | 0.15 |
| Aurvangr | D aeolian | 74 | 0.25 |
| Zeta Reticuli IV | A♭ phrygian | 82 | 0.70 |
| Khepri | F aeolian | 88 | 0.35 |
| Hive Prime | C♯ phrygian | 92 | 0.55 |
| Draco IX | C phrygian | 78 | 0.60 |

Each level gets **two tracks**: an *ambient* pass for traversal and a *combat*
pass for firefights. Generate both — the engine already gates its own stems on a
0–1 intensity value, and having two recorded tracks lets the same crossfade drive
recorded music too.

## How to use these

1. Suno → **Custom Mode**.
2. Paste the **Style** line into the style/genre box.
3. Paste the **Exclude** line into "Exclude styles" (v4.5+). If your version has
   no exclude field, append it to the style box as `no vocals, no drop, ...`.
4. Paste the **Structure** block into the lyrics box. It contains only section
   tags, which is how you get an instrumental with a deliberate arc instead of a
   random one.
5. Set length to **3:00–4:00** for ambient, **2:00–2:30** for combat.
6. Generate 4 takes per prompt and keep the one whose *first 8 seconds* work,
   because the track is entered mid-phrase on level load, not from a cold start.

### Loop preparation

Suno does not produce loops. For each keeper: trim to the nearest bar, apply a
1.5 s crossfade from the tail back over the head, and export **OGG Vorbis q5
mono** for ambient / **q6 stereo** for combat. Ambient beds do not need stereo —
the game's reverb bus widens them anyway, and mono halves the download.

### Integration note

There is currently **no code path that loads an audio file**: all game audio is
synthesised at runtime (`src/core/Audio.ts` bakes buffers, `MusicEngine`
sequences them). Dropping these tracks in needs a small loader — fetch
`music/<id>_<ambient|combat>.ogg`, decode into an `AudioBuffer`, and play it on
`mixer.buses.music` with the same 2.4 s fade `setAmbience` already uses for the
ambience bed. Until that exists, these prompts are asset prep, not a live
feature.

---

## 0. Star Map — *The Ophiuchus Reach*

Cold, vast, unhurried. This plays while the player is picking a target, so it has
to survive being listened to for minutes at a time without demanding attention.

**Style**
```
Slow cinematic space ambient in G aeolian at 66 BPM. Vast bowed string pad, deep sub drone, sparse pizzicato cello, distant analogue choir. Wide reverb, slow swells, no percussion until halfway. Cold, lonely, patient. Blade Runner 2049 meets Destiny orbit theme.
```

**Exclude**
```
vocals, lyrics, drums, EDM, dubstep, drop, trap, guitar, upbeat, major key, retro synthwave
```

**Structure**
```
[Instrumental]
[Intro: sub drone and bowed pad, no rhythm]
[Section A: pizzicato cello figure enters, sparse]
[Section B: choir pad swells underneath, still no drums]
[Section C: soft taiko heartbeat, very low in the mix]
[Outro: everything falls away to the drone]
```

---

## 1. Aurvangr — *Frozen Marches · Jötunn Clans*

Tide-locked ice world in permanent low sun. Nordic raiders on a glacier shelf.
The register is **ritual, not action-movie Viking** — restraint is what sells the
cold.

### 1a. Ambient — *Glacier Shelf*

**Style**
```
Frozen Nordic ritual ambient in D aeolian at 74 BPM. Bowed double bass, low male throat-hum drone, bone flute, struck ice and metal resonances, distant frame drum. Huge cold reverb, wind bed underneath. Solemn, ancient, patient. Sparse.
```

**Exclude**
```
lyrics, folk singing, fiddle, upbeat drums, orchestral fanfare, EDM, brass stabs, major key
```

**Structure**
```
[Instrumental]
[Intro: wind bed and low bowed drone]
[Section A: bone flute motif, long held notes]
[Section B: struck ice percussion, irregular, unquantised]
[Section C: low male hum enters in fifths]
[Outro: flute alone into wind]
```

### 1b. Combat — *Rune-Forged*

**Style**
```
Heavy Nordic war percussion over D aeolian drone at 74 BPM, half-time feel. Massive taiko and frame drums, low brass clusters, distorted bowed bass, male battle-hum in fifths. Cold metallic transients. Relentless, martial, no melody — pure momentum.
```

**Exclude**
```
lyrics, clean vocals, guitar solo, EDM drop, trap hats, cheerful brass fanfare, major key
```

**Structure**
```
[Instrumental]
[Intro: two bars of drum alone]
[Section A: full taiko groove, brass cluster on the downbeat]
[Section B: bowed bass ostinato joins, drums thin out]
[Section C: everything together, male hum on top]
[Outro: hard cut to a single drum hit]
```

---

## 2. Zeta Reticuli IV — *Ashen Flats · The Custodians*

A stripped grey desert under a near-black sky, catalogued by greys who have been
here longer than the Federation has existed. Highest industrial bias of the five
worlds: this one should sound **manufactured**, like being inside an instrument
that is measuring you.

### 2a. Ambient — *Under Survey*

**Style**
```
Clinical alien ambient in A-flat phrygian at 82 BPM. Sine drones in slow beating detune, granular metallic shimmer, filtered noise sweeps, ping-like sonar transients on an irregular grid. Sterile, airless, unsettling. Almost no reverb tail — dry and close.
```

**Exclude**
```
vocals, lyrics, orchestra, strings section, drums, warm pads, melody, guitar, major key
```

**Structure**
```
[Instrumental]
[Intro: single sine drone, slow detune beating]
[Section A: sonar pings enter, irregular spacing]
[Section B: granular metallic shimmer builds]
[Section C: low filtered pulse, machine-steady]
[Outro: pings thin out, drone alone]
```

### 2b. Combat — *Non-Party to the Survey*

**Style**
```
Cold industrial combat music in A-flat phrygian at 82 BPM. Sequenced metallic percussion, hard-gated noise bursts, detuned saw drone with a flat-second grind, clanging factory transients. Machine-precise, no swing, no humanity. Building tension, never resolving.
```

**Exclude**
```
vocals, lyrics, acoustic drums, orchestral strings, melody, dubstep wobble, uplifting resolution, major key
```

**Structure**
```
[Instrumental]
[Intro: gated noise burst pattern]
[Section A: sequenced metal percussion, locked grid]
[Section B: detuned saw drone enters with flat-second grind]
[Section C: everything doubles in density, still no resolution]
[Outro: abrupt gate close]
```

---

## 3. Khepri — *Acid Canopy · Bladed Broods*

Vertical jungle over a corrosive floodplain, hunted from above by mantids. This
is the **organic** end of the palette — wet, chittering, alive. It should feel
crowded rather than empty.

### 3a. Ambient — *High Canopy*

**Style**
```
Humid alien jungle ambient in F aeolian at 88 BPM. Wooden and bamboo percussion, prepared piano harmonics, wet clicking insect textures, bowed metal, breathy low flute. Dense, layered, close-miked. Dripping and alive under a slow dark drone.
```

**Exclude**
```
vocals, lyrics, tribal chanting cliché, world-music flute solo, EDM, drums kit, major key, cheerful
```

**Structure**
```
[Instrumental]
[Intro: insect texture bed and low drone]
[Section A: bamboo percussion, loose and unquantised]
[Section B: prepared piano harmonics answer the percussion]
[Section C: bowed metal swell, everything tightens]
[Outro: back to insects and drone]
```

### 3b. Combat — *They Do Not Miss Twice*

**Style**
```
Frantic organic combat percussion in F aeolian at 88 BPM. Fast wooden and skin drums in shifting 7/8, snapping bladed metal transients, low brass swells, shrieking bowed harmonics. Predatory, agile, always accelerating. Dense but dry.
```

**Exclude**
```
vocals, lyrics, four-on-the-floor, EDM drop, synth lead, orchestral fanfare, major key
```

**Structure**
```
[Instrumental]
[Intro: single wooden drum, shifting meter established]
[Section A: full percussion in 7/8, bladed metal accents]
[Section B: low brass swell under the drums]
[Section C: bowed harmonic shrieks over the top, tempo pushing]
[Outro: percussion stops dead, one metal ring-out]
```

---

## 4. Hive Prime — *The Spore Reach · Unnumbered*

The whole crust is one nest. No leadership, no territory — only the count, and
the count is always rising. The music's job is **numbers**: a texture built from
too many small things, none of which is a soloist.

### 4a. Ambient — *The Count Is Rising*

**Style**
```
Swarming alien ambient in C-sharp phrygian at 92 BPM. Dense granular clouds of tiny clicks and wing-buzz, chittering resonators, low chest-cavity drone, distant chitinous knocking. Constant subtle motion, no clear pulse. Claustrophobic, organic, overwhelming.
```

**Exclude**
```
vocals, lyrics, melody, orchestral strings, drum kit, EDM, resolution, major key, calm
```

**Structure**
```
[Instrumental]
[Intro: low chest drone, sparse chitin knocks]
[Section A: granular click cloud enters, thin]
[Section B: cloud density triples, wing-buzz resonance]
[Section C: knocking organises into a near-pulse]
[Outro: density collapses to a single click]
```

### 4b. Combat — *Unnumbered*

**Style**
```
Relentless swarm combat music in C-sharp phrygian at 92 BPM, driving 16th-note pulse. Layered chitinous percussion, buzzing distorted sub, stabbing low brass clusters, granular screech risers that never pay off. Panic-inducing, mechanical, endless.
```

**Exclude**
```
vocals, lyrics, breakdown, EDM drop, trap hats, melodic hook, triumphant brass, major key
```

**Structure**
```
[Instrumental]
[Intro: 16th-note chitin pulse alone]
[Section A: distorted sub buzz locks in underneath]
[Section B: low brass cluster stabs on the offbeats]
[Section C: granular riser builds and cuts off unresolved]
[Outro: pulse continues and fades, no ending]
```

---

## 5. Draco IX — *Cinder Basin · Saurian Legions*

Volcanic forge world and the Legions' staging ground — the campaign's last stop.
This is the only track allowed to sound **grand**. It is still phrygian, so the
grandeur stays threatening rather than heroic.

### 5a. Ambient — *Staging Ground*

**Style**
```
Volcanic forge ambient in C phrygian at 78 BPM. Enormous low brass drone, rumbling sub, distant industrial hammer strikes on a slow irregular grid, metallic scrape resonances, hot air noise bed. Vast, oppressive, slow-breathing. Cathedral-sized reverb on the hammers only.
```

**Exclude**
```
vocals, lyrics, fast drums, EDM, melody, uplifting strings, major key, guitar
```

**Structure**
```
[Instrumental]
[Intro: sub rumble and air noise]
[Section A: low brass drone swells in]
[Section B: distant hammer strikes, irregular, huge reverb]
[Section C: metallic scrapes layer over the brass]
[Outro: one final hammer, long decay]
```

### 5b. Combat — *This Is Where It Stops*

**Style**
```
Epic hostile orchestral-industrial combat in C phrygian at 78 BPM, half-time. Colossal low brass in flat-second clusters, war drums and anvil hits, distorted sub, dark male choir far back in the mix. Slow, crushing, inevitable. Grand but never triumphant.
```

**Exclude**
```
lyrics, clean solo vocals, heroic major-key fanfare, EDM drop, trap hats, guitar solo, resolution
```

**Structure**
```
[Instrumental]
[Intro: anvil hit, long silence, anvil hit]
[Section A: war drums establish the half-time pulse]
[Section B: low brass flat-second cluster over the drums]
[Section C: dark choir enters far back, everything at full weight]
[Outro: drums drop out, brass cluster holds and decays]
```

---

## Consistency notes

Read these before generating, or the six sets will not sound like one score.

- **Phrygian for the hostile worlds, aeolian for the survivable ones.** The
  flattened second is the whole identity of the soundtrack — it is what makes
  Zeta Reticuli, Hive Prime and Draco IX read as *wrong* rather than as *sad*.
  Do not let Suno resolve it; that is what the "no resolution" exclusions are for.
- **No track ends triumphantly.** The player is losing ground for four of the
  five worlds. Endings should decay, cut, or simply stop.
- **No melodic hooks in combat tracks.** A hook you can hum becomes irritating on
  the fortieth firefight. Combat is rhythm, register and density.
- **Keep the ambient tracks below the dialogue-and-effects register.** Nothing
  sustained in 1–4 kHz, which is where gunfire transients and enemy vocalisations
  need to live.
- **Every world's ambient track shares the star map's sub-drone role.** That
  common low anchor is what makes travel between worlds feel like one system
  rather than six unrelated pieces.
