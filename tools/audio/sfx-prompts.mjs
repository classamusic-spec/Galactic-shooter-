/**
 * What to ask ElevenLabs for, and under which sound id.
 *
 * Ids here **override** the procedurally baked buffer of the same name at boot,
 * so the naming has to match `src/core/audio/*.ts` exactly. Anything not listed
 * keeps its synthesised version — see the note at the bottom for what is
 * deliberately left alone and why.
 */

/** Weapon families, mirroring WEAPON_FAMILIES in src/core/Audio.ts. */
const GUNS = {
  autoRifle: ['loud rapid-fire sci-fi assault rifle discharge, hard percussive crack with a metallic bolt slam, close and dry', 1.0],
  pulseRifle: ['sci-fi energy pulse rifle three-round burst, three hard synthetic snaps in quick succession, bright metallic ring', 1.2],
  scoutRifle: ['powerful marksman rifle discharge, deep authoritative crack, woody body, rolling tail', 1.8],
  handCannon: ['heavy magnum revolver discharge, enormous low thump and a whip-sharp crack, cylinder mechanism, long decay', 2.0],
  sidearm: ['loud compact sidearm discharge, bright snapping crack with a metallic slide clack, close and dry', 0.8],
  submachineGun: ['loud submachine gun discharge, hard dry rattle with a light metallic bolt, close quarters, minimal tail', 0.8],
  shotgun: ['combat shotgun blast, huge low boom with a wide noisy spray, pump action rack afterwards, big tail', 2.2],
  sniperRifle: ['high powered sniper rifle discharge, colossal supersonic crack, deep boom, long rolling valley echo', 3.0],
  fusionRifle: ['sci-fi plasma cannon discharge, violent searing energy release with an electrical fizz tail, no charge-up', 1.6],
  rocketLauncher: ['rocket launcher ignition blast, hard percussive whoosh at full force with a roaring exhaust departing fast', 2.0],
  grenadeLauncher: ['grenade launcher thump, hard hollow mortar pop with a mechanical breech clack, short tail', 1.2],
  machineGun: ['heavy belt fed machine gun discharge, brutal deep punch with a heavy metal action clank, big room', 1.4],
  bow: ['compound bow release, hard taut string snap and an arrow shaft whistling away fast', 1.0],
  traceRifle: ['continuous sci-fi laser beam weapon, steady searing hum with electrical crackle, no start or end transient', 2.4],
};

/**
 * Appended to every effect that has to land on the frame it is triggered.
 *
 * The first pass asked for a "single shot" over a one-second window and the model
 * answered with room tone: four of four auto-rifle takes came back at a peak of
 * 0.06 or below, and where it did produce a shot it often placed it a fifth of a
 * second in behind a run-up. Naming the onset explicitly, and shortening the
 * window so the event has to fill it, fixes both.
 */
const ONSET = ' The sound is loud and starts instantly on the very first sample, at full volume, with no silence and no build-up before it.';

/** Non-gun one-shots worth recording. */
const ONESHOTS = {
  explosion_small: ['small grenade explosion, sharp crack then a short gritty debris shower, tight low end', 1.8, 2],
  explosion_medium: ['medium explosion, instant deep percussive boom with a body of noise, debris and dust settling, moderate tail', 2.2, 2],
  explosion_large: ['massive explosion, enormous instant sub-bass detonation, long roaring decay, heavy debris rain, distant rumble', 3.0, 2],

  elem_arc_zap: ['electric arc discharge, violent crackling tesla zap, bright ozone snap, short electrical tail', 1.4],
  elem_solar_ignite: ['sudden fire ignition whoosh, gas igniting into a roaring flame burst, warm crackle', 1.6],
  elem_stasis_shatter: ['thick ice shattering into crystalline shards, sharp glassy crack, tinkling debris', 1.8],
  elem_void_pull: ['dark gravitational void implosion, air sucking inwards, deep inverted whoosh, unsettling low hum', 2.0],

  reload_light: ['fast pistol magazine reload, magazine release click, empty mag drops out, fresh mag slaps in, slide racks', 1.4],
  reload_medium: ['assault rifle magazine reload, mag release, magazine out, new magazine seated firmly, bolt release snap', 1.6],
  reload_heavy: ['heavy machine gun reload, ammunition belt rattling, heavy metal feed tray closing with a solid clunk', 2.0],
  weapon_swap: ['weapon swap foley, rifle sling shifting, hands adjusting on a metal receiver, quick and clean', 1.0],
  weapon_dryfire: ['dry fire click on an empty chamber, hammer falls with a hollow metallic snap, no shot', 0.6],
  weapon_charge: ['sci-fi weapon capacitor charging up, rising electrical whine building tension, ends ready', 1.6],

  melee_swing: ['fast heavy blade slicing through air, hard immediate whoosh, no impact', 0.6],
  melee_hit: ['brutal melee impact on armour, heavy blunt thud with a metallic crunch, wet undertone', 0.9],
  shield_break: ['energy shield shattering, glassy synthetic crack with an electrical collapse and a descending whine', 1.6],
  shield_break_player: ['personal energy shield failing, immediate harsh electrical crack then a warning fizz and a descending power-down', 1.4],
  player_hurt: ['sharp male grunt of pain, short and breathy, single exhale', 0.8],
  player_death: ['male dying gasp, breath leaving the body, slow fading exhale', 2.0],

  super_ready: ['sci-fi power surge ready cue, bright ascending shimmer with a confident resolving swell', 1.6],
  super_cast: ['enormous sci-fi super ability unleashed, huge energy detonation with a rising roar, cinematic weight', 2.6],
  super_end: ['sci-fi energy powering down, descending whine dissolving into a soft electrical hiss', 1.8],
};

/** Enemy vocalisations. Species character comes from the adjectives, not a voice. */
const SPECIES = {
  nordic: 'huge armoured nordic giant warrior, deep guttural human-like roar, cavernous chest',
  grey: 'small grey alien, thin dry synthetic clicking and a reedy nasal shriek, uncanny and inorganic',
  mantis: 'huge predatory mantis insect, sharp chitinous clicking and a rasping hiss, bladed limbs scraping',
  insectoid: 'swarming insectoid drone, wet chittering and buzzing wing vibration, many small mouths',
  reptilian: 'large reptilian saurian warrior, throaty bellowing hiss with a deep growl, wet reptile throat',
  federation: 'human soldier in a sealed helmet, radio-filtered voice, terse and clipped',
};
const STATES = {
  idle: ['idle vocalisation, low and unbothered, short', 1.0],
  alert: ['alerted call, sudden sharp rising cry of detection', 1.2],
  attack: ['aggressive attack cry, violent and committed', 1.2],
  hurt: ['cry of pain, sharp and wounded, short', 0.9],
  death: ['death cry, collapsing into a wet gurgling fade', 1.8],
};

/** @returns {{id: string, prompt: string, seconds: number}[]} */
/** Mirrors TRANSIENT_TRIM in src/core/audio/SfxPack.ts. */
const NEEDS_ONSET = ['gun_', 'explosion_', 'impact_', 'melee_', 'step_', 'weapon_dryfire', 'shield_break'];

export function sfxJobs() {
  const jobs = [];
  const add = (id, prompt, seconds) =>
    jobs.push({
      id,
      prompt: NEEDS_ONSET.some((p) => id.startsWith(p)) ? `${prompt}.${ONSET}` : prompt,
      seconds,
    });

  // Take counts must match the synthesised bank exactly (GUN_TAKES = 4,
  // VOICE_TAKES = 3). A short pack leaves the surplus takes synthesised, and the
  // runtime picks between takes at random — so one shot in four would sound like
  // a different weapon.
  for (const [family, [prompt, seconds]] of Object.entries(GUNS)) {
    for (let take = 0; take < 4; take++) add(`gun_${family}_${take}`, prompt, seconds);
  }
  for (const [id, [prompt, seconds, takes]] of Object.entries(ONESHOTS)) {
    if (takes) for (let t = 0; t < takes; t++) add(`${id}_${t}`, prompt, seconds);
    else add(id, prompt, seconds);
  }
  for (const [faction, body] of Object.entries(SPECIES)) {
    for (const [state, [tail, seconds]] of Object.entries(STATES)) {
      for (let take = 0; take < 3; take++) {
        add(`voice_${faction}_${state}_${take}`, `${body}, ${tail}. No music, no reverb tail.`, seconds);
      }
    }
  }
  return jobs;
}

/**
 * Deliberately NOT generated, and why:
 *
 * - `hitmarker*`, `ui_*` — need to land inside one frame of the input that
 *   caused them and are a few hundred bytes synthesised. A downloaded sample is
 *   strictly worse on both counts.
 * - `impact_*`, `step_*` — 8 surfaces x 3 takes x 2 (impact + footstep) fired
 *   many times a second. Procedural variation is what keeps them from reading as
 *   a loop, and no realistic number of takes matches that.
 * - `amb_*`, `*_loop` — must loop seamlessly. The bake folds each one back on
 *   itself with a crossfade; generated audio has no such guarantee.
 * - `enemyfire_*` — enemy weapons are pitch-shifted per archetype at runtime,
 *   which needs a synthetic source that survives transposition.
 */
