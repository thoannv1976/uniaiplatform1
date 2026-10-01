import type { FirebaseOptions } from 'firebase/app';

/** Base URL of the API on Cloud Run. The web calls it directly (not via Hosting rewrites). */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';

/** Domain hinted on the Google account chooser (decision D2). The API enforces it. */
export const EMAIL_DOMAIN: string =
  (import.meta.env.VITE_EMAIL_DOMAIN as string | undefined) ?? 'ftu.edu.vn';

export const USE_AUTH_EMULATOR = import.meta.env.VITE_USE_AUTH_EMULATOR === 'true';

/**
 * Firebase web config is public (not a secret). Production builds receive it as JSON in
 * VITE_FIREBASE_CONFIG; local development uses a demo project with the Auth emulator.
 */
export function firebaseOptions(): FirebaseOptions {
  const raw = import.meta.env.VITE_FIREBASE_CONFIG as string | undefined;
  if (raw) return JSON.parse(raw) as FirebaseOptions;
  return { apiKey: 'demo-api-key', authDomain: 'localhost', projectId: 'demo-uniai' };
}
