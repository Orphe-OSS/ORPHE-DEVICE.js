import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const sdkEntry = fileURLToPath(new URL('src/index.ts', import.meta.url));
const isSdk = (id: string) => id === sdkEntry || id === '../index.ts';

// orphe-core-insole-toolkit.js: SDK 本体は含めず、先に読み込んだ orphe-core-insole.js（OrpheCoreInsoleJS）を使う
// `--mode min` で圧縮版 orphe-core-insole-toolkit.min.js を出す
export default defineConfig(({ mode }) => {
  const min = mode === 'min';
  return {
    build: {
      outDir: 'dist/browser',
      emptyOutDir: false,
      minify: min,
      lib: {
        entry: fileURLToPath(new URL('src/toolkit/entry.ts', import.meta.url)),
        name: 'OrpheCoreInsoleToolkit',
        formats: ['iife'],
        fileName: () => (min ? 'orphe-core-insole-toolkit.min.js' : 'orphe-core-insole-toolkit.js'),
      },
      rollupOptions: {
        external: isSdk,
        output: {
          // 圧縮版でもクラス名・関数名を未圧縮版と同じにする
          keepNames: min,
          globals: (id: string) => (isSdk(id) ? 'OrpheCoreInsoleJS' : id),
        },
      },
    },
  };
});
