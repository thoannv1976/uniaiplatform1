import { usdToMicro } from '@uniai/shared';

/** Parses an admin-typed USD amount ("0.25" or "0,25") into micro-USD; null if invalid. */
export function parseUsd(text: string): number | null {
  const value = Number(text.trim().replace(',', '.'));
  if (text.trim() === '' || !Number.isFinite(value) || value < 0) return null;
  return usdToMicro(value);
}
