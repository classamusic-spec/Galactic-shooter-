import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

/**
 * Capture-only dev server.
 *
 * Identical to the normal config except HMR is off. Agents write into src/
 * continuously, and every write makes the HMR client reload the page — which
 * wipes the harness state mid-capture and yields a screenshot of a loading
 * screen. Captures need a server that ignores file changes.
 */
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  server: {
    host: '127.0.0.1',
    port: 5200,
    strictPort: true,
    hmr: false,
    watch: { ignored: ['**/*'] },
  },
});
