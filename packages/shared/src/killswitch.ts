import { z } from 'zod';
import {
  MODEL_TIERS,
  PROVIDER_IDS,
  modelIdSchema,
  type ModelTier,
  type ProviderId,
} from './models.js';

/**
 * Kill switch (spec 8.8): settings/killSwitch, watched by every API instance (< 5 s). It
 * stops all AI, some providers, some models or some model tiers. The usage job can turn on
 * the emergency brake (advanced + premium tiers) when university spend reaches
 * `autoBrakePercent` of its budget (spec 8.7).
 */
export const killSwitchSchema = z.object({
  all: z.boolean(),
  providers: z.array(z.enum(PROVIDER_IDS)),
  models: z.array(z.string()),
  tiers: z.array(z.enum(MODEL_TIERS)),
  /** Shown to users while something is switched off. */
  reason: z.string(),
  /** % of the university budget that turns on the emergency brake; null = never. */
  autoBrakePercent: z.number().int().min(50).max(200).nullable(),
  /** True when the emergency brake set the current state. */
  auto: z.boolean(),
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type KillSwitch = z.infer<typeof killSwitchSchema>;

export const DEFAULT_KILL_SWITCH: KillSwitch = {
  all: false,
  providers: [],
  models: [],
  tiers: [],
  reason: '',
  autoBrakePercent: 100,
  auto: false,
  updatedBy: null,
  updatedAt: null,
};

/** Tiers the emergency brake switches off. */
export const AUTO_BRAKE_TIERS: ModelTier[] = ['advanced', 'premium'];

export const updateKillSwitchRequestSchema = z
  .object({
    all: z.boolean(),
    providers: z.array(z.enum(PROVIDER_IDS)).max(PROVIDER_IDS.length),
    models: z.array(modelIdSchema).max(200),
    tiers: z.array(z.enum(MODEL_TIERS)).max(MODEL_TIERS.length),
    reason: z.string().trim().max(300),
    autoBrakePercent: z.number().int().min(50).max(200).nullable(),
  })
  .strict()
  .refine(
    (v) =>
      !(v.all || v.providers.length || v.models.length || v.tiers.length) || v.reason.length >= 5,
    { message: 'Cần ghi lý do (ít nhất 5 ký tự) khi tắt AI', path: ['reason'] },
  );
export type UpdateKillSwitchRequest = z.infer<typeof updateKillSwitchRequestSchema>;

/** Why a model may not be used now, or null when it may. */
export function killSwitchBlocks(
  ks: Pick<KillSwitch, 'all' | 'providers' | 'models' | 'tiers' | 'reason'>,
  model: { id: string; providerId: ProviderId; tier: ModelTier },
): string | null {
  const why = ks.reason ? ` Lý do: ${ks.reason}` : '';
  if (ks.all) return `Hệ thống AI đang tạm dừng.${why}`;
  if (
    ks.providers.includes(model.providerId) ||
    ks.models.includes(model.id) ||
    ks.tiers.includes(model.tier)
  ) {
    return `Model này đang tạm dừng.${why}`;
  }
  return null;
}
