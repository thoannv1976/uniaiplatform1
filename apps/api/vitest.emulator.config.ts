import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// Runs inside `firebase emulators:exec` (see root `pnpm test:emulator`).
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['src/**/*.emulator.test.ts'],
    fileParallelism: false,
  },
});
