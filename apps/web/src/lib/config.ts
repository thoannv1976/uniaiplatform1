/** Base URL of the API on Cloud Run. The web calls it directly (not via Hosting rewrites). */
export const API_URL: string =
  (import.meta.env.VITE_API_URL as string | undefined) ?? 'http://localhost:8080';
