import { describe, expect, it } from 'vitest';
import {
  DEFAULT_KILL_SWITCH,
  killSwitchBlocks,
  updateKillSwitchRequestSchema,
} from './killswitch.js';

const model = { id: 'gpt-x', providerId: 'openai' as const, tier: 'advanced' as const };

describe('killSwitchBlocks', () => {
  it('blocks everything, a provider, a model or a tier', () => {
    expect(killSwitchBlocks(DEFAULT_KILL_SWITCH, model)).toBeNull();
    expect(killSwitchBlocks({ ...DEFAULT_KILL_SWITCH, all: true, reason: 'Bảo trì' }, model)).toBe(
      'Hệ thống AI đang tạm dừng. Lý do: Bảo trì',
    );
    expect(killSwitchBlocks({ ...DEFAULT_KILL_SWITCH, providers: ['openai'] }, model)).toBe(
      'Model này đang tạm dừng.',
    );
    expect(killSwitchBlocks({ ...DEFAULT_KILL_SWITCH, models: ['gpt-x'] }, model)).not.toBeNull();
    expect(killSwitchBlocks({ ...DEFAULT_KILL_SWITCH, tiers: ['advanced'] }, model)).not.toBeNull();
    expect(killSwitchBlocks({ ...DEFAULT_KILL_SWITCH, tiers: ['premium'] }, model)).toBeNull();
  });
});

describe('updateKillSwitchRequestSchema', () => {
  const base = {
    all: false,
    providers: [],
    models: [],
    tiers: [],
    reason: '',
    autoBrakePercent: 100,
  };
  it('needs a reason only when something is switched off', () => {
    expect(updateKillSwitchRequestSchema.safeParse(base).success).toBe(true);
    expect(updateKillSwitchRequestSchema.safeParse({ ...base, all: true }).success).toBe(false);
    expect(
      updateKillSwitchRequestSchema.safeParse({ ...base, all: true, reason: 'Sự cố nhà cung cấp' })
        .success,
    ).toBe(true);
    expect(updateKillSwitchRequestSchema.safeParse({ ...base, autoBrakePercent: 10 }).success).toBe(
      false,
    );
  });
});
