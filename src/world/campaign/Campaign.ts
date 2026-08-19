/**
 * The campaign: what each mission is called, why the player is there, and what
 * they learn by finishing it.
 *
 * The game shipped with five encounter scripts and no connective tissue. Two of
 * five planet descriptions referenced a plot; the other three referenced
 * nothing. No character ever spoke to the player. Meanwhile `ui:subtitle` — a
 * complete speaker-attributed dialogue channel, styled and wired into the HUD —
 * had never once been emitted by gameplay code.
 *
 * This module is the missing content and the thing that plays it. It owns the
 * mission titles, the chapter order, and the handler traffic; everything else
 * about a mission (its waves, its objectives) stays in the planet's own
 * `encounterScript`.
 *
 * Text here is bound by docs/STORY.md. In particular: the word "Choir" must not
 * appear before chapter 2, because chapter 2 is where the player learns it.
 */
import type { PlanetId } from '@/types';
import { events } from '@/core/EventBus';

export interface Chapter {
  planet: PlanetId;
  /** 1-based. Matches the star map's campaign order. */
  chapter: number;
  /** Two words, no colon. See docs/STORY.md. */
  title: string;
  /** Handler traffic before the drop. */
  briefing: readonly string[];
  /** Handler traffic on the clear. This is where the story actually advances. */
  debrief: readonly string[];
}

/** The voice in your ear. Never seen, runs six operations at once. */
export const HANDLER = 'Vanguard Actual';

export const CHAPTERS: readonly Chapter[] = [
  {
    planet: 'aurvangr',
    chapter: 1,
    title: 'Cold Contract',
    briefing: [
      'Survey network went dark eleven days ago. Six teams. No distress, no wreckage, no bodies.',
      'Jötunn clans hold the glacier shelf. They have never taken a contract off-world. They have taken this one.',
      'Find out who is paying them.',
    ],
    debrief: [
      'Their axes are clan-forged. The rest of it is not.',
      'That is Custodian work. Zeta Reticuli — they have been in this system longer than we have been a species.',
      'Go and ask them why they are arming mercenaries.',
    ],
  },
  {
    planet: 'zeta-reticuli',
    chapter: 2,
    title: 'Silent Archive',
    briefing: [
      'The Custodians are not a war species. They are archivists.',
      'They will treat you as contamination in the record. Do not expect to talk your way in.',
      'Our survey ship Halberd went down inside their perimeter. Get to it.',
    ],
    debrief: [
      'The Archive was raided. Not by us, and not by the Jötunn.',
      'The recorder pulled one fragment before it died. Something they catalogued and left alone for a very long time.',
      'They called it the Choir. The Saurian Legions took the rest of the file.',
      'The fragment points at Khepri.',
    ],
  },
  {
    planet: 'khepri',
    chapter: 3,
    title: 'Green Rot',
    briefing: [
      "The fragment's coordinates put the test site under Khepri's canopy.",
      'Bladed Broods hunt from above. Keep to high ground and keep moving.',
      'Some of what is down there is not hunting any more. You will know which.',
    ],
    debrief: [
      'Half of them fought like predators. The other half fought like one animal wearing forty bodies.',
      'That is the Choir, mid-process. Khepri is eighteen months in.',
      'Hive Prime is eighteen months past. Go and look at what it finishes.',
    ],
  },
  {
    planet: 'hive-prime',
    chapter: 4,
    title: 'The Count',
    briefing: [
      'There is no leadership on this world. No territory. No negotiation.',
      'The Unnumbered are not a faction. They are what a biosphere becomes when the Choir finishes with it.',
      'Eight hundred million people live inside the projected spread. That is the number I want you carrying.',
      // The only time in the campaign the handler breaks procedure.
      'Sorry. Go.',
    ],
    debrief: [
      'Confirmed. No command structure anywhere in the sample. It is all one thing.',
      'The Legions have the core, and a fleet on the pad at Draco IX.',
      'They think they are carrying a weapon.',
    ],
  },
  {
    planet: 'draco-ix',
    chapter: 5,
    title: 'Iron Choir',
    briefing: [
      'Cinder Basin. The Legions have been massing for a push into Federation space for a year.',
      'The core is inside the fortress. If that fleet lifts with it aboard, every world it touches becomes Hive Prime.',
      'This is where it stops.',
    ],
    debrief: [
      'Core is cold. Fleet is grounded.',
      'The Archive named its buyers. Some of them are ours.',
      'Come home, Guardian. We will talk about that when you land.',
    ],
  },
];

const BY_PLANET = new Map<PlanetId, Chapter>(CHAPTERS.map((c) => [c.planet, c]));

export function chapterFor(planet: PlanetId): Chapter | null {
  return BY_PLANET.get(planet) ?? null;
}

/**
 * Play a chapter's briefing or debrief.
 *
 * Lines go out as `briefing:line`, which the UI's sequencer paces and delivers
 * through the subtitle channel — this module deliberately does no timing of its
 * own, because only the UI knows whether the player is currently being shot at.
 */
export function playBriefing(planet: PlanetId): void {
  const c = BY_PLANET.get(planet);
  if (!c) return;
  for (const text of c.briefing) events.emit('briefing:line', { speaker: HANDLER, text });
}

export function playDebrief(planet: PlanetId): void {
  const c = BY_PLANET.get(planet);
  if (!c) return;
  for (const text of c.debrief) events.emit('briefing:line', { speaker: HANDLER, text });
}
