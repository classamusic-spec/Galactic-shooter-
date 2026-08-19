# Campaign — Mission Specification

The five chapters, written against `MissionDef` in `src/types.ts` and the story
spine in `docs/STORY.md`. This is the content contract: an implementer should be
able to build the campaign from this document without inventing prose.

## Why this document exists

The shipped game had five encounter scripts that were mechanically identical —
three waves of "kill N where you stand", then a champion — with objective text
that described things the code never checked. "Advance to the Jötunn hall"
spawned enemies *behind* the player and completed without moving. "Reach the
survey vessel Halberd" excluded the Halberd's spawn volume entirely. Every verb
in every objective line was a lie.

Two rules follow from that, and they govern everything below:

1. **No objective may use a verb the code does not check.** If the line says
   reach, hold, destroy or retrieve, there is a position, a timer or a target
   entity behind it. Otherwise the verb is *clear*, and the line says so.
2. **Every landmark named in text already exists in the level.** The builders are
   listed per chapter. Nothing here asks for new geometry.

## Boss correction

Four of five worlds finished on a *champion*-rank unit (900–1100 HP) while their
actual boss archetypes sat built, registered, given behaviour trees, and never
spawned. Draco IX alone used a real boss (6200 HP), making the final world
roughly six times the wall of the other four.

Every chapter now ends on its real boss:

| World | Was | Is | Boss HP |
|---|---|---|---|
| Aurvangr | `nordic.jarl` (champion) | `nordic.allfather` | 4200 |
| Zeta Reticuli IV | `grey.overseer` (champion) | `grey.overmind` | 4200 |
| Khepri | `mantis_matriarch` (champion) | `mantis_apex` | 4600 |
| Hive Prime | `insect_broodmother` (champion) | `insect_hivelord` | 5200 |
| Draco IX | `rept_tyrant` (boss) | `rept_tyrant` | 6200 |

The displaced champions stay in the final wave as elites, which is what they were
designed for. Boss objective text is per-world and names the target — it was
hardcoded to `'Eliminate the champion'` for all five.

---

## Chapter 1 — Aurvangr — **Cold Contract**

*Landmarks: `buildAvenue(15,36)`, `buildHall(38,96,14)`, `buildGreatGate(120)`.*

**Briefing**
- VANGUARD ACTUAL — "Survey network went dark eleven days ago. Six teams. No distress, no wreckage, no bodies."
- VANGUARD ACTUAL — "Jötunn clans hold the glacier shelf. They have never taken a contract off-world. They have taken this one."
- VANGUARD ACTUAL — "Find out who is paying them."

**Objectives**
1. `advance` — "Advance up the avenue" → the avenue's far end (~36 m forward, radius 12). Skirmish spawns ahead, not behind.
2. `clear` — "Break the shield line in the nave" → inside the hall, huscarls and raiders.
3. `destroy` — "Destroy the rune stone" → the hall's rune stone. This is the first destructible objective in the game; it must have a health bar.
4. `boss` — "Kill the Allfather" → `nordic.allfather` at the great gate.

**Debrief**
- VANGUARD ACTUAL — "Their axes are clan-forged. The rest of it is not."
- VANGUARD ACTUAL — "That is Custodian work. Zeta Reticuli. They have been in this system longer than we have been a species."
- VANGUARD ACTUAL — "Go and ask them why they are arming mercenaries."

---

## Chapter 2 — Zeta Reticuli IV — **Silent Archive**

*Landmarks: `buildWreck(94,6)` (the survey vessel *Halberd*), `buildCustodianArray()`, `buildMonolithField()`.*
*Requires: Chapter 1.*

**Briefing**
- VANGUARD ACTUAL — "The Custodians are not a war species. They are archivists. They have catalogued this system since before we had language."
- VANGUARD ACTUAL — "They will treat you as contamination in the record. Do not expect to talk your way in."
- VANGUARD ACTUAL — "Our survey ship *Halberd* went down inside their perimeter. Get to it."

**Objectives**
1. `advance` — "Reach the Halberd" → the wreck at (94, 6), radius 14. The wreck's spawn volume is *included* this time.
2. `hold` — "Hold the wreck while the recorder dumps" → 45 s inside radius 18 of the wreck, under pressure. First hold objective in the game; the HUD shows the timer.
3. `clear` — "Clear the Custodian array" → the array field.
4. `boss` — "Kill the Overmind" → `grey.overmind`.

**Debrief**
- VANGUARD ACTUAL — "The Archive was raided. Not by us, and not by the Jötunn."
- VANGUARD ACTUAL — "The recorder pulled one fragment before it died. A catalogue entry. Something they filed and left alone for a very long time."
- VANGUARD ACTUAL — "They called it the Choir. The Saurian Legions took the rest of the file."
- VANGUARD ACTUAL — "The fragment points at Khepri."

*(This is the first time the word "Choir" appears anywhere in the game. Chapter 1 does not know it.)*

---

## Chapter 3 — Khepri — **Green Rot**

*Landmarks: `buildBroodSpire(94,-6)`, `buildPod(...)` (brood pods), `buildFloodplain()`.*
*Requires: Chapter 2.*

**Briefing**
- VANGUARD ACTUAL — "The fragment's coordinates put the test site under Khepri's canopy."
- VANGUARD ACTUAL — "Bladed Broods hunt from above. Keep to high ground and keep moving."
- VANGUARD ACTUAL — "Some of what is down there is not hunting any more. You will know which."

**Objectives**
1. `advance` — "Cross the floodplain" → far bank, radius 12.
2. `destroy` — "Burn out the brood pods" → three `buildPod` instances, each destructible. The line finally means what it says.
3. `advance` — "Take the Brood Spire" → spire base at (94, −6), radius 16.
4. `boss` — "Kill the Apex" → `mantis_apex` at the spire.

**Debrief**
- VANGUARD ACTUAL — "Half of them fought like predators. The other half fought like one animal wearing forty bodies."
- VANGUARD ACTUAL — "That is the Choir, mid-process. Khepri is eighteen months in."
- VANGUARD ACTUAL — "Hive Prime is eighteen months *past*. Go and look at what it finishes."

---

## Chapter 4 — Hive Prime — **The Count**

*Landmarks: `buildAvenue()`, the brood arena.*
*Requires: Chapter 3.*

**Briefing**
- VANGUARD ACTUAL — "There is no leadership on this world. No territory. No negotiation."
- VANGUARD ACTUAL — "The Unnumbered are not a faction. They are what a biosphere becomes when the Choir finishes with it."
- VANGUARD ACTUAL — "Eight hundred million people live inside the projected spread. That is the number I want you carrying."
- *(pause — thirty seconds of silence, then:)*
- VANGUARD ACTUAL — "Sorry. Go."

*(This is the only time in the campaign the handler breaks procedure. It is not repeated.)*

**Objectives**
1. `hold` — "Hold the avenue mouth" → 60 s, radius 20. The verb is finally accurate: this is the game's defensive set piece.
2. `advance` — "Push to the brood arena" → arena centre, radius 16.
3. `clear` — "Break the clutch" → the arena's spawners.
4. `boss` — "Kill the Hivelord" → `insect_hivelord`.

**Debrief**
- VANGUARD ACTUAL — "Confirmed. No command structure anywhere in the sample. It is all one thing."
- VANGUARD ACTUAL — "The Legions have the core and a fleet on the pad at Draco IX."
- VANGUARD ACTUAL — "They think they are carrying a weapon."

---

## Chapter 5 — Draco IX — **Iron Choir**

*Landmarks: `buildFortress()`.*
*Requires: Chapter 4.*

**Briefing**
- VANGUARD ACTUAL — "Cinder Basin. The Legions have been massing for a push into Federation space for a year."
- VANGUARD ACTUAL — "The core is inside the fortress. If that fleet lifts with it aboard, every world it touches becomes Hive Prime."
- VANGUARD ACTUAL — "This is where it stops."

**Objectives**
1. `advance` — "Advance on the legion gate" → gate, radius 14.
2. `clear` — "Break the shield line" → legionaries and pyroclasts at the wall.
3. `destroy` — "Destroy the Choir core" → the campaign's final destructible, inside the fortress. Long health bar; the arena keeps spawning while it burns.
4. `boss` — "Kill Tyrant Vorrakh" → `rept_tyrant`.

**Debrief**
- VANGUARD ACTUAL — "Core is cold. Fleet is grounded."
- VANGUARD ACTUAL — "The Archive named its buyers. Some of them are ours."
- VANGUARD ACTUAL — "Come home, Guardian. We will talk about that when you land."

*(The campaign's one unresolved thread, raised and dropped deliberately. See
docs/STORY.md — "The Federation is not clean".)*

---

## Objective-line rules

From `docs/STORY.md`, restated because this is where they get broken:

- **Instruction first.** A player glancing at the HUD mid-firefight must learn
  what to do from the first three words.
- **No word the player cannot act on.** "Sever the resonance lattice" is only
  legal if there is a lattice on screen with a health bar. This is why chapter 2
  says *hold the wreck* and not *sever the psionic link*.
- **Boss lines name the target.** Never "the champion".

## Delivery

No new UI is needed. `ui:subtitle` is a complete speaker-attributed dialogue
channel that has never been emitted by gameplay code; briefings and debriefs go
through it via `briefing:line`. Objectives use the existing `objective:updated`
card. Mission titles and chapter numbers go to the results screen and star map.
