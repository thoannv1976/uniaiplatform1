import { defineConfig } from 'vitest/config';

// Runs inside `firebase emulators:exec` (see root `pnpm test:emulator`).
export default defineConfig({
  test: {
    include: ['src/**/*.emulator.test.ts'],
    fileParallelism: false,
  },
});
