import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// example/ をルートに、src/ の TypeScript を直接 import して動かす。
// Web Bluetooth は localhost が secure context なので dev サーバでそのまま使える。
export default defineConfig({
  root: 'example',
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        index: fileURLToPath(new URL('example/index.html', import.meta.url)),
        core: fileURLToPath(new URL('example/core.html', import.meta.url)),
        insole: fileURLToPath(new URL('example/insole.html', import.meta.url)),
        auto: fileURLToPath(new URL('example/auto.html', import.meta.url)),
      },
    },
  },
});
