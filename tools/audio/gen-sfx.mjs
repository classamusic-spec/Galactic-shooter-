#!/usr/bin/env node
/**
 * Generate the sound bank with ElevenLabs' sound-effects model.
 *
 * Usage:
 *   ELEVENLABS_API_KEY=... node tools/audio/gen-sfx.mjs [--only gun_,explosion_]
 *                                                       [--force] [--concurrency 4]
 *
 * The key is read from the environment and is never written anywhere. Output
 * goes to `public/sfx/<id>.mp3` plus a `manifest.json` the runtime reads.
 *
 * Re-runnable by design: a file that already exists is skipped, so a run that
 * dies on a quota limit or a network fault resumes where it stopped instead of
 * paying for the same 90 effects twice. `--force` regenerates anyway.
 */
import { mkdirSync, existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sfxJobs } from './sfx-prompts.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = resolve(ROOT, 'public/sfx');

const argv = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const FORCE = argv.includes('--force');
const ONLY = arg('only', '').split(',').map((s) => s.trim()).filter(Boolean);
/** Exact ids, as printed by qa-sfx.mjs. Takes precedence over --only. */
const IDS = new Set(arg('ids', '').split(',').map((s) => s.trim()).filter(Boolean));
const CONCURRENCY = Math.max(1, Number(arg('concurrency', '4')));

const KEY = process.env.ELEVENLABS_API_KEY;
if (!KEY) {
  console.error('Set ELEVENLABS_API_KEY in the environment. Do not pass it as an argument —');
  console.error('arguments land in shell history and in the process list.');
  process.exit(2);
}

mkdirSync(OUT, { recursive: true });

const jobs = sfxJobs().filter((j) =>
  IDS.size ? IDS.has(j.id) : !ONLY.length || ONLY.some((p) => j.id.startsWith(p)),
);
const todo = jobs.filter((j) => FORCE || IDS.size || !existsSync(resolve(OUT, `${j.id}.mp3`)));
console.log(`${jobs.length} effects in scope, ${todo.length} to generate`);

let done = 0;
const failed = [];

async function generate(job) {
  const body = {
    text: job.prompt,
    duration_seconds: Math.min(22, Math.max(0.5, job.seconds)),
    // Below ~0.5 the model drifts toward "musical" interpretations of the text;
    // high values track the prompt literally, which is what a sound bank wants.
    prompt_influence: 0.65,
  };
  // Five attempts with backoff: 429 is the expected failure at this volume and a
  // transient one, so retrying is cheaper than a partial bank.
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(
      'https://api.elevenlabs.io/v1/sound-generation?output_format=mp3_44100_128',
      {
        method: 'POST',
        headers: { 'xi-api-key': KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
    );
    if (res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 512) throw new Error(`suspiciously small response (${buf.length} B)`);
      writeFileSync(resolve(OUT, `${job.id}.mp3`), buf);
      return buf.length;
    }
    const text = await res.text().catch(() => '');
    // 4xx other than rate limiting will not fix itself — fail fast and keep the
    // message, which is where the quota and permission errors show up.
    if (res.status !== 429 && res.status < 500) throw new Error(`${res.status} ${text.slice(0, 200)}`);
    await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
  }
  throw new Error('gave up after 5 attempts');
}

async function worker(queue) {
  for (;;) {
    const job = queue.pop();
    if (!job) return;
    try {
      const bytes = await generate(job);
      done++;
      console.log(`  ✓ ${job.id} (${(bytes / 1024).toFixed(0)} kB)  ${done}/${todo.length}`);
    } catch (err) {
      failed.push({ id: job.id, error: String(err.message ?? err) });
      console.log(`  ✗ ${job.id}: ${err.message ?? err}`);
    }
  }
}

const queue = todo.slice().reverse();
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker(queue)));

// The manifest is rebuilt from what is actually on disk, not from the job list,
// so a partial run produces a manifest the runtime can use rather than one that
// promises files that are not there.
const present = readdirSync(OUT)
  .filter((f) => f.endsWith('.mp3'))
  .sort()
  .map((f) => ({ id: f.slice(0, -4), bytes: statSync(resolve(OUT, f)).size }));
writeFileSync(
  resolve(OUT, 'manifest.json'),
  `${JSON.stringify({ generator: 'elevenlabs/sound-generation', ids: present.map((p) => p.id) }, null, 2)}\n`,
);

const totalMb = present.reduce((a, p) => a + p.bytes, 0) / 1e6;
console.log(`\n${present.length} effects on disk, ${totalMb.toFixed(2)} MB total`);
if (failed.length) {
  console.log(`${failed.length} failed:`);
  for (const f of failed) console.log(`  ${f.id}: ${f.error}`);
  process.exit(1);
}
