import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

// scores/manifest.json is generated from whatever *.musicxml files are in
// public/scores/, never committed. Locally that is the whole library; in CI only
// public-domain/ exists, so the deployed manifest never lists a file that 404s.
function scoresManifest(): Plugin {
  const dir = here('./public/scores');

  const tag = (xml: string, re: RegExp) => xml.match(re)?.[1].trim() ?? '';

  function build() {
    if (!existsSync(dir)) return [];
    const files = readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.musicxml'))
      .sort();
    return files.map((f) => {
      const xml = readFileSync(join(dir, f), 'utf8').slice(0, 4000);
      const path = relative(dir, join(dir, f)).split('\\').join('/');
      return {
        id: path.replace(/\.musicxml$/, ''),
        title: tag(xml, /<work-title>([^<]*)</) || tag(xml, /<movement-title>([^<]*)</) || path,
        composer: tag(xml, /<creator type="composer">([^<]*)</),
        path,
      };
    });
  }

  return {
    name: 'scores-manifest',
    configureServer(server) {
      server.middlewares.use('/scores/manifest.json', (_req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(build()));
      });
    },
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'scores/manifest.json',
        source: JSON.stringify(build()),
      });
    },
  };
}

export default defineConfig(({ command }) => ({
  // Served from https://gpiantoni.github.io/piano-trainer/ in production,
  // but from the root during dev so localhost URLs stay short.
  base: command === 'build' ? '/piano-trainer/' : '/',

  plugins: [scoresManifest()],

  build: {
    // verovio-module is ~8 MB of embedded WASM, loaded lazily. Expected, not a bug.
    chunkSizeWarningLimit: 9000,
    rollupOptions: {
      // spike.html is a second entry point: it ships with the deployed app so the
      // MIDI debugger is available on the tablet, not just on the laptop.
      input: { main: here('./index.html'), spike: here('./spike.html') },
    },
  },

  server: {
    // `npm run dev -- --host` exposes it on the LAN; handy with `adb reverse`.
    port: 5173,
  },
}));
