import { Body, Controller, Get, HttpCode, Inject, Post, Put } from '@nestjs/common';
import type { DlpPolicyStore } from '@uniai/firestore';
import {
  actionFor,
  decide,
  dlpPolicySchema,
  dlpTestRequestSchema,
  maskText,
  scanText,
  type DlpPolicyView,
  type DlpTestResponse,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import type { AuthContext } from '../auth/auth.guard.js';
import { CurrentAuth } from '../auth/current-user.js';
import { Roles } from '../auth/decorators.js';
import { parseOrBadRequest } from '../common/zod.js';
import { DLP_POLICY_STORE, DlpService } from './dlp.service.js';

/** DLP rules (spec 8.11): Super Admin edits, Auditor reads. */
@Controller('api/admin/dlp-rules')
export class DlpController {
  constructor(
    @Inject(DLP_POLICY_STORE) private readonly store: DlpPolicyStore,
    private readonly service: DlpService,
    private readonly audit: AuditService,
  ) {}

  @Get()
  @Roles('super_admin', 'auditor')
  async get(): Promise<DlpPolicyView> {
    return this.store.get();
  }

  @Put()
  @Roles('super_admin')
  async set(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<DlpPolicyView> {
    const policy = parseOrBadRequest(dlpPolicySchema, body);
    const before = (await this.store.get()).policy;
    await this.store.set(policy, auth.profile.uid);
    this.service.invalidate();
    await this.audit.record({
      event: 'ADMIN_CHANGE',
      actor: auth.profile.uid,
      target: 'settings:dlp',
      metadata: {
        action: 'dlp_policy',
        before: { defaults: before.defaults, overrides: before.overrides.length },
        after: { defaults: policy.defaults, overrides: policy.overrides.length },
      },
    });
    return this.store.get();
  }

  /** What the current policy would do with a sample text, for the caller (nothing is stored). */
  @Post('test')
  @HttpCode(200)
  @Roles('super_admin')
  async test(@CurrentAuth() auth: AuthContext, @Body() body: unknown): Promise<DlpTestResponse> {
    const { text } = parseOrBadRequest(dlpTestRequestSchema, body);
    const { policy } = await this.store.get();
    const findings = scanText(text);
    const subject = await this.service.subject(auth.profile, policy);
    const decision = decide(findings, policy, subject);
    return {
      action: decision.action,
      findings: findings.map((f) => ({
        detector: f.detector,
        action: actionFor(policy, f.detector, subject),
      })),
      masked: maskText(text, findings, decision.byAction.mask ?? []),
    };
  }
}
