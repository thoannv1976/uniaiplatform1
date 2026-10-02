import { HttpException, Inject, Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { DlpPolicyStore, UserStore } from '@uniai/firestore';
import {
  actionFor,
  decide,
  DLP_CONFIRM_STATUS,
  DLP_DETECTOR_LABELS_VI,
  DLP_DETECTORS,
  maskText,
  scanText,
  type DlpDecision,
  type DlpDetector,
  type DlpPolicy,
  type UserProfile,
} from '@uniai/shared';
import { AuditService } from '../audit/audit.service.js';
import { USER_STORE } from '../auth/auth.guard.js';

export const DLP_POLICY_STORE = Symbol('DLP_POLICY_STORE');
const POLICY_TTL_MS = 30_000;

const labels = (ds: DlpDetector[]) =>
  [...new Set(ds)].map((d) => DLP_DETECTOR_LABELS_VI[d].toLowerCase()).join(', ');

/** The outcome for one chat request: what to mask and what the user confirmed. */
export interface DlpOutcome {
  decision: DlpDecision;
  /** Detectors whose values are replaced by placeholders before sending (per policy). */
  mask: DlpDetector[];
  /** Placeholder → original value, shared by everything sent in this request. */
  mapping: Map<string, string>;
  /** Masks `text` (any part of the prompt: message, files, history, project). */
  apply(text: string): string;
}

/**
 * DLP (spec 8.11): every text the user adds to a request is scanned before it reaches a
 * provider. block → 422; warn → 428 until the user confirms (dlpAcknowledged); mask →
 * placeholders. Policy from settings/dlp, cached 30 s and reloaded after an admin change.
 * Values found are never logged: audit entries carry detector names and counts.
 */
@Injectable()
export class DlpService {
  private policy: { value: Awaited<ReturnType<DlpPolicyStore['get']>>; at: number } | null = null;

  constructor(
    @Inject(DLP_POLICY_STORE) private readonly store: DlpPolicyStore,
    private readonly audit: AuditService,
    @Inject(USER_STORE) private readonly users: UserStore,
  ) {}

  /** Role and unit path for the policy (the path is read only when an override needs it). */
  async subject(user: UserProfile, policy: DlpPolicy) {
    const byUnit = policy.overrides.some((o) => o.departmentIds.length > 0);
    return {
      role: user.role,
      departmentPath: byUnit ? await this.users.departmentPathOf(user.uid) : [],
    };
  }

  async state() {
    if (!this.policy || Date.now() - this.policy.at > POLICY_TTL_MS) {
      this.policy = { value: await this.store.get(), at: Date.now() };
    }
    return this.policy.value;
  }

  invalidate() {
    this.policy = null;
  }

  /** Throws 422/428 before anything is stored or reserved; otherwise returns the masker. */
  async check(user: UserProfile, texts: string[], acknowledged: boolean): Promise<DlpOutcome> {
    const { policy } = await this.state();
    const subject = await this.subject(user, policy);
    const decision = decide(
      texts.flatMap((t) => scanText(t)),
      policy,
      subject,
    );
    const blocked = decision.byAction.block ?? [];
    const warned = decision.byAction.warn ?? [];
    if (blocked.length) {
      this.record(user, 'block', decision);
      throw new UnprocessableEntityException(
        `Tin nhắn hoặc tệp đính kèm chứa ${labels(blocked)} nên không được gửi tới AI theo quy định bảo vệ dữ liệu của Trường. Vui lòng xóa thông tin này rồi gửi lại.`,
      );
    }
    if (warned.length && !acknowledged) {
      this.record(user, 'warn', decision, 'confirm_required');
      throw new HttpException(
        `Nội dung có thể chứa ${labels(warned)}. Bạn có chắc muốn gửi tới AI không?`,
        DLP_CONFIRM_STATUS,
      );
    }
    // Every detector masked for this user, not only those found now: earlier messages
    // in the conversation are sent again and must stay masked.
    const mask = DLP_DETECTORS.filter((d) => actionFor(policy, d, subject) === 'mask');
    const mapping = new Map<string, string>();
    return {
      decision,
      mask,
      mapping,
      apply: (text) => (mask.length ? maskText(text, scanText(text), mask, mapping) : text),
    };
  }

  /** Audit entry for a request that was blocked, held for confirmation, masked or confirmed. */
  record(
    user: UserProfile,
    action: 'block' | 'warn' | 'mask',
    decision: DlpDecision,
    outcome: 'blocked' | 'confirm_required' | 'sent' = action === 'block' ? 'blocked' : 'sent',
    target = `users/${user.uid}`,
  ) {
    this.audit.recordQuietly({
      event: 'DLP_ACTION',
      actor: user.uid,
      target,
      metadata: { action, outcome, counts: decision.counts, byAction: decision.byAction },
    });
  }
}
