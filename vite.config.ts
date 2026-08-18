import { defineConfig } from 'vite';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
    chunkSizeWarningLimit: 4096,
    rollupOptions: {
      output: {
        // Vite 8's rolldown bundler requires manualChunks as a function, not the
        // object form Rollup accepted. Split three.js into its own chunk so the
        // engine code and the ~1 MB library cache separately.
        manualChunks(id) {
          if (id.includes('node_modules/three')) return 'three';
          return undefined;
        },
      },
    },
  },
  server: { host: '0.0.0.0', port: 5173, strictPort: false },
});
