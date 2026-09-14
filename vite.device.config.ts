import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

// orphe-device.js: <script> ではグローバル OrpheDeviceJS、require() では module.exports
// `--mode min` で圧縮版 orphe-device.min.js を出す（未圧縮版のビルドを先に実行すること）
export default defineConfig(({ mode }) => {
  const min = mode === 'min';
  return {
    build: {
      outDir: 'dist/browser',
      emptyOutDir: !min,
      minify: min,
      lib: {
        entry: fileURLToPath(new URL('src/browser.ts', import.meta.url)),
        name: 'OrpheDeviceJS',
        formats: ['umd'],
        fileName: () => (min ? 'orphe-device.min.js' : 'orphe-device.js'),
      },
      // 圧縮版でも Orphe.name などのクラス名・関数名を未圧縮版と同じにする
      rollupOptions: { output: { keepNames: min } },
    },
  };
});
