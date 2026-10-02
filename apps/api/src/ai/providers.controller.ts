import {
  BadGatewayException,
  BadRequestException,
  Body,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Put,
} from '@nestjs/common';
import type { RegistryStore } from '@uniai/firestore';
import {
  PROVIDER_IDS,
  setProviderKeyRequestSchema,
  updateProviderRequestSchema,
  type ProviderId,
  type ProviderView,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { ProviderRuntime } from './provider-runtime.js';
import { RegistryCache } from './registry-cache.js';
import { REGISTRY_STORE } from './tokens.js';

export function providerIdOr404(raw: string): ProviderId {
  if (!(PROVIDER_IDS as readonly string[]).includes(raw)) {
    throw new NotFoundException(`Không có nhà cung cấp ${raw}.`);
  }
  return raw as ProviderId;
}

@Controller('api/admin/providers')
export class ProvidersController {
  constructor(
    @Inject(REGISTRY_STORE) private readonly registry: RegistryStore,
    private readonly runtime: ProviderRuntime,
    private readonly cache: RegistryCache,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'ai_admin', 'auditor')
  async list(): Promise<{ providers: ProviderView[] }> {
    return { providers: await this.registry.listProviders() };
  }

  @Patch(':id')
  @Roles('super_admin', 'ai_admin')
  async update(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<ProviderView> {
    const id = providerIdOr404(rawId);
    const patch = parseOrBadRequest(updateProviderRequestSchema, body);
    const { before, after } = await this.registry.updateProvider(id, patch, auth.profile.uid);
    this.cache.invalidate();
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `provider:${id}`,
      metadata: {
        action: 'update_provider',
        changes: patch,
        before: {
          transport: before.transport,
          enabled: before.enabled,
          fallbackOrder: before.fallbackOrder,
        },
      },
    });
    return after;
  }

  /**
   * Write-only: the key goes to Secret Manager as a new version (ADR 0002). Only its last
   * 4 characters are kept, in Firestore and in the audit log.
   */
  @Put(':id/key')
  @Roles('super_admin')
  async setKey(
    @CurrentAuth() auth: AuthContext,
    @Param('id') rawId: string,
    @Body() body: unknown,
  ): Promise<ProviderView> {
    const id = providerIdOr404(rawId);
    if (id === 'mock') throw new BadRequestException('Mock provider không dùng API key.');
    const { apiKey } = parseOrBadRequest(setProviderKeyRequestSchema, body);
    try {
      await this.runtime.storeKey(id, apiKey);
    } catch {
      // Never include the error object: it is about the request that carried the key.
      throw new BadGatewayException(
        `Không lưu được API key vào Secret Manager (secret ${this.runtime.secretName(id)}). ` +
          'Kiểm tra secret đã được tạo và uniai-api có quyền secretVersionAdder.',
      );
    }
    const last4 = apiKey.slice(-4);
    const view = await this.registry.recordKey(id, last4, auth.profile.uid);
    this.cache.invalidate();
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: `provider:${id}`,
      metadata: { action: 'set_provider_key', secret: this.runtime.secretName(id), last4 },
    });
    return view;
  }
}
