// Replays saved Follow runs (Save run's JSON) through analyseFollow and prints
// one row per run and pause rule, as in follow-mode-plan.md's Reference data.
//
// It runs the app's own code in headless Chromium, through the dev server.
// playwright-core is not a project dependency: install it anywhere outside.
//
//   npm i --prefix /some/scratch/dir playwright-core
//   npx vite --port 5199 --strictPort
//   PW=/some/scratch/dir node scripts/replay-follow.mjs <score.musicxml> <run.json>... [--pause=1,2]
//
// --pause adds rows with a fixed pause threshold in beats; the match window
// (the default rule) is always the first row. Env: URL (default
// http://localhost:5199), CHROMIUM (default /usr/bin/chromium).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const fixed = (args.find((a) => a.startsWith('--pause='))?.slice(8).split(',') ?? []).map(Number);
const [scorePath, ...runPaths] = args.filter((a) => !a.startsWith('--'));
if (!process.env.PW || !scorePath || runPaths.length === 0) {
  console.error('usage: PW=<dir with playwright-core> node scripts/replay-follow.mjs <score.musicxml> <run.json>... [--pause=1,2]');
  process.exit(1);
}
const { chromium } = createRequire(`${process.env.PW}/`)('playwright-core');

const text = readFileSync(scorePath, 'utf8');
const runs = runPaths.map((p) => ({ name: basename(p, '.json'), ...JSON.parse(readFileSync(p, 'utf8')) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = await browser.newPage();
  await page.goto(process.env.URL ?? 'http://localhost:5199');
  const rows = await page.evaluate(async ({ text, title, runs, fixed }) => {
    const { analyseFollow } = await import('/src/engine/follow.ts');
    const { loadScore } = await import('/src/score/load.ts');
    const { inWindow } = await import('/src/score/section.ts');
    const L = await import('/src/review/layers.ts');
    const timing = await loadScore({ kind: 'xml', text }, title);
    const rows = [];
    for (const run of runs) {
      const events = timing.events.filter((ev) => inWindow(run.window, ev.onMs));
      for (const rule of ['window', ...fixed]) {
        const row = { run: run.name, rule: rule === 'window' ? 'match window' : `${rule} beat${rule === 1 ? '' : 's'}` };
        for (const within of [0.2, 0.1]) {
          const s = { ...L.DEFAULT_SETTINGS, within };
          const range = L.windowOf(s);
          const opts = { hands: run.hands, window: run.window, pauseBeats: rule === 'window' ? range : rule };
          const a = analyseFollow(events, run.recording, run.speed, opts, timing.pedals);
          const c = L.context(a, s, run.speed, { ms: undefined, notes: 0 }, true);
          const k = L.counts(a, s, c);
          // Past the match window the colour clamps at full.
          const beyond = a.notes.filter((n) => n.deltaPct !== undefined && Math.abs(n.deltaPct) > range * 100).length;
          row[within] = { ...k, pauses: L.pauses(a), beyond };
        }
        rows.push(row);
      }
    }
    return rows;
  }, { text, title: runs[0].title ?? basename(scorePath), runs, fixed });

  console.log('| run | pause rule | ±20 %: within | early | late | untimed | pauses | beyond the colour range | total | ±10 %: within | pauses |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { run, rule, 0.2: w, 0.1: n } of rows) {
    console.log(`| ${run} | ${rule} | ${w.within} | ${w.early} | ${w.late} | ${w.untimed} | ${w.pauses} | ${w.beyond} | ${w.total} | ${n.within} | ${n.pauses} |`);
  }
} finally {
  await browser.close();
}
