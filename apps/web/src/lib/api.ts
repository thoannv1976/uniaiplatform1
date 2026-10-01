import { healthResponseSchema, type HealthResponse } from '@uniai/shared';
import { API_URL } from './config';

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/healthz`, { signal });
  if (!res.ok) throw new Error(`API trả về mã ${res.status}`);
  return healthResponseSchema.parse(await res.json());
}
