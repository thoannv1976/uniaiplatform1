import { defineConfig, devices } from '@playwright/test';

const API_PORT = 8090;

// `pnpm test:e2e` (repo root) runs inside the Firebase emulators, which set
// FIRESTORE_EMULATOR_HOST / FIREBASE_AUTH_EMULATOR_HOST; the servers below inherit them.
const withEmulators = Boolean(process.env.FIRESTORE_EMULATOR_HOST);

export default defineConfig({
  testDir: './e2e',
  globalSetup: './e2e/global-setup.ts',
  timeout: 30_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Sandboxes with a pre-installed Chromium (e.g. Claude Code on the web) set this
        // instead of downloading browsers; CI runs `playwright install chromium`.
        launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
          ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
          : {},
      },
    },
  ],
  webServer: [
    {
      command: 'node ../api/dist/main.js',
      url: `http://localhost:${API_PORT}/health`,
      env: {
        PORT: String(API_PORT),
        WEB_ORIGINS: 'http://localhost:4173',
        APP_VERSION: 'e2e',
        ENABLE_MOCK_PROVIDER: 'true',
      },
      reuseExistingServer: false,
    },
    {
      command: `pnpm exec vite build && pnpm exec vite preview`,
      url: 'http://localhost:4173',
      env: {
        VITE_API_URL: `http://localhost:${API_PORT}`,
        VITE_USE_AUTH_EMULATOR: withEmulators ? 'true' : 'false',
      },
      reuseExistingServer: false,
      timeout: 120_000,
    },
  ],
});
