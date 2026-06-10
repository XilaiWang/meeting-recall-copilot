import { resolve } from 'node:path';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        // embed-worker is forked as an Electron utilityProcess (lib/embedding.ts); it
        // needs its own entry so it builds to out/main/embed-worker.js.
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          'embed-worker': resolve(__dirname, 'src/main/embed-worker.ts'),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/renderer/index.html') },
      },
    },
    // Why: @timephy/rnnoise-wasm only exports "." and "./NoiseSuppressorWorklet"
    // in its package.json exports map. We use internal subpaths for the sync
    // WASM module and processor class, so alias them to their real file paths
    // to bypass Vite's exports-map enforcement at dev and build time.
    resolve: {
      alias: {
        '@timephy/rnnoise-wasm/dist/generated/rnnoise-sync.js': resolve(
          __dirname,
          'node_modules/@timephy/rnnoise-wasm/dist/generated/rnnoise-sync.js',
        ),
        '@timephy/rnnoise-wasm/dist/RnnoiseProcessor.js': resolve(
          __dirname,
          'node_modules/@timephy/rnnoise-wasm/dist/RnnoiseProcessor.js',
        ),
      },
    },
  },
});
