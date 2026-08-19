/**
 * Briefing — the handler's voice, sequenced.
 *
 * `briefing:line` is a *request*: gameplay says "Vanguard Actual has something
 * to say" and stops caring. Turning that into speech is a scheduling problem,
 * and this file is the scheduler. It owns no DOM of its own — the finished
 * pacing is pushed back onto the bus as `ui:subtitle`, the speaker-attributed
 * channel the HUD already renders. That keeps exactly one subtitle surface in
 * the game and makes every line the sequencer emits look identical to one a
 * cutscene emitted by hand.
 *
 * Three rules drive the whole design:
 *
 * 1. **Never talk over itself.** One line holds the channel until its read time
 *    is up, then a short beat of silence, then the next. Nothing is ever
 *    emitted while something else is still holding.
 *
 * 2. **Read time comes from the line, not from a constant.** A four-word bark
 *    and a thirty-word briefing paragraph are the same event with wildly
 *    different needs; a fixed delay is either an insult to one or a stall for
 *    the other.
 *
 * 3. **A firefight outranks exposition.** `docs/STORY.md` makes sentence length
 *    the mood dial: mid-firefight lines run under eight words, briefings run
 *    long. That gives the sequencer a free classifier — word count *is* the
 *    author's own statement of whether a line was written to be read while
 *    being shot at. Short lines are never gated. Long lines wait for the fight
 *    to end, and if the fight outlasts their relevance they are dropped rather
 *    than delivered late.
 *
 * On (3), the alternative was truncation. Rejected: cutting a briefing line to
 * eight words invents a sentence the writer never wrote, in a game whose story
 * bible treats sentence length as a deliberate instrument. Deferring handles
 * the common case — a stray shot during the drop — and dropping handles the
 * pathological one, where a line about a room you left two minutes ago is worse
 * than silence. Neither can stall the queue: a deferred line has a deadline and
 * short lines walk straight past it.
 */
import { events } from '@/core/EventBus';
import { clamp } from '@/util/math';

/**
 * Word count at or under which a line is treated as a mid-firefight bark. Taken
 * straight from the story bible's "mid-firefight lines run under eight words".
 */
const COMBAT_WORDS = 8;

/** Read-time model: a beat to notice the line, then ~185 wpm. */
const READ_BASE = 0.8;
const READ_PER_WORD = 0.32;
const MIN_HOLD = 1.8;
const MAX_HOLD = 8;

/** Silence between consecutive lines, so two lines never read as one sentence. */
const GAP = 0.42;

/** How long a shot keeps the sequencer in "combat" after the last one lands. */
const COMBAT_TAIL = 3;
/** Same, driven from the AI director's intensity rather than from single hits. */
const THREAT_TAIL = 2.5;
const THREAT_ON = 0.15;

/**
 * A deferred briefing line older than this is discarded. Fourteen seconds is
 * about two engagements: long enough that a single skirmish never costs the
 * player a line, short enough that nothing arrives referring to a moment that
 * has already been survived.
 */
const STALE = 14;

/** Queue ceiling. Overflow evicts the oldest *long* line, never a bark. */
const MAX_QUEUE = 12;

/** Second press inside this window means "I have heard all of it". */
const DOUBLE_TAP = 0.7;

interface Line {
  speaker: string;
  text: string;
  /** Seconds this line should hold the channel. */
  hold: number;
  /** True for the short lines written to be read mid-firefight. */
  urgent: boolean;
  /** Sequencer clock at queue time — the staleness deadline reads this. */
  queuedAt: number;
}

function words(text: string): number {
  const m = text.trim().match(/\S+/g);
  return m ? m.length : 0;
}

export class Briefing {
  /** Lines waiting for the channel, in arrival order. */
  private readonly queue: Line[] = [];
  private active: Line | null = null;
  /** Seconds left on the active line. */
  private hold = 0;
  /** Seconds of enforced silence before the next line may start. */
  private gap = 0;
  /** Seconds of "recently shot at" left. Long lines wait while this is > 0. */
  private combat = 0;
  /** Monotonic presentation clock, seconds since construction. */
  private clock = 0;
  private lastSkip = -99;
  private readonly unbind: (() => void)[] = [];

  constructor() {
    this.unbind.push(events.on('briefing:line', (p) => this.enqueue(p.speaker, p.text, p.duration)));

    // Combat is reconstructed from the event stream — the UI never asks
    // gameplay a question, it only listens to what gameplay already announced.
    const hot = (): void => {
      this.combat = Math.max(this.combat, COMBAT_TAIL);
    };
    this.unbind.push(events.on('player:damaged', hot));
    this.unbind.push(events.on('enemy:damaged', hot));
    this.unbind.push(events.on('enemy:killed', hot));
    this.unbind.push(
      events.on('combat:threat', (p) => {
        if (p.level > THREAT_ON) this.combat = Math.max(this.combat, THREAT_TAIL);
      }),
    );

    // A queue is scoped to one mission. Carrying it across a load would put the
    // previous world's handler traffic over the next world's drop.
    this.unbind.push(events.on('level:loaded', () => this.reset()));
    this.unbind.push(events.on('mission:started', () => this.reset()));
  }

  /** Lines still waiting for the channel. Read by the debug hooks only. */
  get pending(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  /** True while a line holds the channel. */
  get speaking(): boolean {
    return this.active !== null;
  }

  // -- queueing --------------------------------------------------------------

  private enqueue(speaker: string, text: string, duration?: number): void {
    const body = text.trim();
    if (!body) return;
    const n = words(body);
    const urgent = n <= COMBAT_WORDS;
    const line: Line = {
      speaker: speaker || 'Vanguard Actual',
      text: body,
      hold: duration ?? clamp(READ_BASE + n * READ_PER_WORD, MIN_HOLD, MAX_HOLD),
      urgent,
      queuedAt: this.clock,
    };

    // A bark arriving over a briefing paragraph wins the channel outright: it
    // is, by the story bible's own definition, the line written for this exact
    // moment. The paragraph goes back to the head of the queue and is re-read
    // from the top once the shooting stops — or expires there.
    if (urgent && this.active && !this.active.urgent) {
      this.queue.unshift(this.active);
      this.play(line);
      return;
    }

    if (this.queue.length >= MAX_QUEUE) {
      const victim = this.queue.findIndex((l) => !l.urgent);
      if (victim < 0) return; // all barks — dropping the newest is the honest loss
      this.queue.splice(victim, 1);
    }
    this.queue.push(line);
  }

  // -- transport -------------------------------------------------------------

  /**
   * Advance the read. A press ends the line on screen; a second press inside
   * `DOUBLE_TAP` throws the rest of the queue away, which is the only thing a
   * player who has already heard the briefing actually wants.
   */
  skip(): void {
    const doubled = this.clock - this.lastSkip < DOUBLE_TAP;
    this.lastSkip = this.clock;
    if (doubled || !this.active) {
      this.lastSkip = -99;
      this.reset();
      return;
    }
    this.active = null;
    this.hold = 0;
    this.gap = GAP * 0.5;
    this.clear();
  }

  /** Drop everything and blank the channel. Safe to call at any time. */
  reset(): void {
    this.queue.length = 0;
    this.active = null;
    this.hold = 0;
    this.gap = 0;
    this.combat = 0;
    this.clear();
  }

  private clear(): void {
    events.emit('ui:subtitle', { speaker: '', text: '', duration: 0 });
  }

  private play(line: Line): void {
    this.active = line;
    this.hold = line.hold;
    this.gap = 0;
    // A hair longer than the sequencer's own hold so the HUD never blanks for a
    // frame between "this line ended" and "the next one starts".
    events.emit('ui:subtitle', {
      speaker: line.speaker,
      text: line.text,
      duration: line.hold + 0.2,
    });
  }

  // -- frame -----------------------------------------------------------------

  /** Frame-time driven: this is pacing, which is presentation, not simulation. */
  render(dt: number): void {
    this.clock += dt;
    this.combat = Math.max(0, this.combat - dt);

    if (this.hold > 0) {
      this.hold -= dt;
      if (this.hold > 0) return;
      this.active = null;
      this.gap = GAP;
      return;
    }
    if (this.gap > 0) {
      this.gap -= dt;
      if (this.gap > 0) return;
    }
    this.pump();
  }

  private pump(): void {
    // Expire deferred paragraphs first, so a stale one never blocks the line
    // behind it for the one frame before it would have been dropped anyway.
    for (let i = this.queue.length - 1; i >= 0; i--) {
      const l = this.queue[i];
      if (!l.urgent && this.clock - l.queuedAt > STALE) this.queue.splice(i, 1);
    }
    if (this.queue.length === 0) return;

    // In a fight, only barks are eligible; out of it, strict arrival order.
    const idx = this.combat > 0 ? this.queue.findIndex((l) => l.urgent) : 0;
    if (idx < 0) return;
    this.play(this.queue.splice(idx, 1)[0]);
  }

  dispose(): void {
    for (const off of this.unbind) off();
    this.unbind.length = 0;
    this.queue.length = 0;
    this.active = null;
  }
}
