// Replays saved Follow runs (Save run's JSON) through analyseFollow and prints
// one row per run, as in follow-mode-plan.md's Reference data.
//
// It runs the app's own code in headless Chromium, through the dev server.
// playwright-core is not a project dependency: install it anywhere outside.
//
//   npm i --prefix /some/scratch/dir playwright-core
//   npx vite --port 5199 --strictPort
//   PW=/some/scratch/dir node scripts/replay-follow.mjs <score.musicxml> <run.json>...
//
// Env: URL (default http://localhost:5199), CHROMIUM (default /usr/bin/chromium).

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { createRequire } from 'node:module';

const [scorePath, ...runPaths] = process.argv.slice(2);
if (!process.env.PW || !scorePath || runPaths.length === 0) {
  console.error('usage: PW=<dir with playwright-core> node scripts/replay-follow.mjs <score.musicxml> <run.json>...');
  process.exit(1);
}
const { chromium } = createRequire(`${process.env.PW}/`)('playwright-core');

const text = readFileSync(scorePath, 'utf8');
const runs = runPaths.map((p) => ({ name: basename(p, '.json'), ...JSON.parse(readFileSync(p, 'utf8')) }));

const browser = await chromium.launch({ executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium' });
try {
  const page = await browser.newPage();
  await page.goto(process.env.URL ?? 'http://localhost:5199');
  const rows = await page.evaluate(async ({ text, title, runs }) => {
    const { analyseFollow } = await import('/src/engine/follow.ts');
    const { loadScore } = await import('/src/score/load.ts');
    const { inWindow } = await import('/src/score/section.ts');
    const L = await import('/src/review/layers.ts');
    const timing = await loadScore({ kind: 'xml', text }, title);
    const rows = [];
    for (const run of runs) {
      const events = timing.events.filter((ev) => inWindow(run.window, ev.onMs));
      const row = { run: run.name };
      for (const within of [0.2, 0.1]) {
        const s = { ...L.DEFAULT_SETTINGS, within };
        const range = L.windowOf(s);
        const opts = { hands: run.hands, window: run.window, within, matchBeats: range };
        const a = analyseFollow(events, run.recording, run.speed, opts, timing.pedals);
        const c = L.context(a, s, run.speed, { ms: undefined, notes: 0 }, true);
        const k = L.counts(a, s, c);
        const restarts = new Set(a.notes.filter((n) => n.restart === 'outside').map((n) => n.expected.onMs)).size;
        // Past the match window the colour clamps at full.
        const beyond = a.notes.filter((n) => n.deltaPct !== undefined && Math.abs(n.deltaPct) > range * 100).length;
        row[within] = { ...k, restarts, beyond };
      }
      rows.push(row);
    }
    return rows;
  }, { text, title: runs[0].title ?? basename(scorePath), runs });

  console.log('| run | ±20 %: within | early | late | untimed | clock restarts | beyond the colour range | total | ±10 %: within | early | late | clock restarts |');
  console.log('|---|---|---|---|---|---|---|---|---|---|---|---|');
  for (const { run, 0.2: w, 0.1: n } of rows) {
    console.log(`| ${run} | ${w.within} | ${w.early} | ${w.late} | ${w.untimed} | ${w.restarts} | ${w.beyond} | ${w.total} | ${n.within} | ${n.early} | ${n.late} | ${n.restarts} |`);
  }
} finally {
  await browser.close();
}
