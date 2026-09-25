import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// orphe-core-insole.js: <script> ではグローバル OrpheCoreInsoleJS、require() では module.exports
// `--mode min` で圧縮版 orphe-core-insole.min.js を出す（未圧縮版のビルドを先に実行すること）
export default defineConfig(({ mode }) => {
  const min = mode === 'min';
  return {
    build: {
      outDir: 'dist/browser',
      emptyOutDir: !min,
      minify: min,
      lib: {
        entry: fileURLToPath(new URL('src/browser.ts', import.meta.url)),
        name: 'OrpheCoreInsoleJS',
        formats: ['umd'],
        fileName: () => (min ? 'orphe-core-insole.min.js' : 'orphe-core-insole.js'),
      },
      // 圧縮版でも Orphe.name などのクラス名・関数名を未圧縮版と同じにする
      rollupOptions: { output: { keepNames: min } },
    },
  };
});
