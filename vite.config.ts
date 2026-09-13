import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig(({ command }) => ({
  // Served from https://gpiantoni.github.io/piano-trainer/ in production,
  // but from the root during dev so localhost URLs stay short.
  base: command === 'build' ? '/piano-trainer/' : '/',

  build: {
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
