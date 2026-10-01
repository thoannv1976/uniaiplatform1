import {
  apiErrorSchema,
  healthResponseSchema,
  meResponseSchema,
  type HealthResponse,
  type MeResponse,
} from '@uniai/shared';
import { API_URL } from './config';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readError(res: Response): Promise<ApiError> {
  const parsed = apiErrorSchema.safeParse(await res.json().catch(() => null));
  return new ApiError(
    res.status,
    parsed.success ? parsed.data.message : `API trả về mã ${res.status}`,
  );
}

export async function fetchHealth(signal?: AbortSignal): Promise<HealthResponse> {
  const res = await fetch(`${API_URL}/healthz`, { signal });
  if (!res.ok) throw await readError(res);
  return healthResponseSchema.parse(await res.json());
}

export async function fetchMe(idToken: string, signal?: AbortSignal): Promise<MeResponse> {
  const res = await fetch(`${API_URL}/api/me`, {
    headers: { Authorization: `Bearer ${idToken}` },
    signal,
  });
  if (!res.ok) throw await readError(res);
  return meResponseSchema.parse(await res.json());
}
