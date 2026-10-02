import { execFileSync } from 'node:child_process';
import { E2E_USER } from './e2e-user';

/**
 * Full-stack runs (`pnpm test:e2e` wraps Playwright in the Firebase emulators): fresh data,
 * the sample registry (mock models) and one active user. Without emulators only the static
 * checks run.
 */
export default function globalSetup() {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_AUTH_EMULATOR_HOST) return;
  execFileSync('node', ['e2e/seed-e2e.mjs', E2E_USER.email, E2E_USER.password], {
    stdio: 'inherit',
  });
}
