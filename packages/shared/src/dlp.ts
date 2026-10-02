import { z } from 'zod';
import { ROLES, type Role } from './roles.js';

/**
 * DLP & Policy Engine (spec 8.11): runs before anything is sent to an AI provider. Detectors
 * find sensitive data; the policy decides allow / warn (the user confirms) / mask (replaced by
 * [CCCD_1]… before sending) / block. Findings never leave the request: audit logs keep only
 * detector names and counts.
 */

export const DLP_DETECTORS = [
  'cccd',
  'bank',
  'password',
  'secret',
  'student_data',
  'confidential',
] as const;
export type DlpDetector = (typeof DLP_DETECTORS)[number];

export const DLP_DETECTOR_LABELS_VI: Record<DlpDetector, string> = {
  cccd: 'Số CCCD/CMND',
  bank: 'Số tài khoản / thẻ ngân hàng',
  password: 'Mật khẩu',
  secret: 'API key / khóa bí mật',
  student_data: 'Dữ liệu sinh viên/nhân sự',
  confidential: 'Tài liệu mật',
};

/** Placeholder prefix used when masking. */
const PLACEHOLDER: Record<DlpDetector, string> = {
  cccd: 'CCCD',
  bank: 'STK',
  password: 'MATKHAU',
  secret: 'BIMAT',
  student_data: 'SINHVIEN',
  confidential: 'MAT',
};

export const DLP_ACTIONS = ['allow', 'warn', 'mask', 'block'] as const;
export type DlpAction = (typeof DLP_ACTIONS)[number];
export const DLP_ACTION_LABELS_VI: Record<DlpAction, string> = {
  allow: 'Cho phép',
  warn: 'Cảnh báo (người dùng xác nhận)',
  mask: 'Che trước khi gửi',
  block: 'Chặn',
};
/** Which action wins when several detectors fire. */
const SEVERITY: Record<DlpAction, number> = { allow: 0, mask: 1, warn: 2, block: 3 };

export const DEFAULT_DLP_ACTIONS: Record<DlpDetector, DlpAction> = {
  cccd: 'mask',
  bank: 'mask',
  password: 'block',
  secret: 'block',
  student_data: 'warn',
  confidential: 'block',
};

export interface DlpFinding {
  detector: DlpDetector;
  start: number;
  end: number;
}

// ---------------------------------------------------------------------------
// Detectors

/** Province codes of the 12-digit citizen ID (first 3 digits). */
const PROVINCE_CODES = new Set(
  (
    '001 002 004 006 008 010 011 012 014 015 017 019 020 022 024 025 026 027 030 031 033 034 035 ' +
    '036 037 038 040 042 044 045 046 048 049 051 052 054 056 058 060 062 064 066 067 068 070 072 ' +
    '074 075 077 079 080 082 083 084 086 087 089 091 092 093 094 095 096'
  ).split(' '),
);

const fold = (s: string) =>
  s.normalize('NFD').replace(/\p{M}/gu, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();

/** Text around [start, end) (folded, same length as the original for NFC input). */
function near(text: string, start: number, end: number, before = 40, after = 10): string {
  return fold(text.slice(Math.max(0, start - before), Math.min(text.length, end + after)));
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

function* matches(re: RegExp, text: string) {
  for (const m of text.matchAll(re)) yield { start: m.index!, end: m.index! + m[0].length, m };
}

const BANK_KEYWORDS =
  /\bstk\b|so tai khoan|tai khoan|\btk\b|account|ngan hang|vietcombank|bidv|agribank|techcombank|vietinbank|mb ?bank|\bacb\b|tpbank|sacombank|vpbank/;

function cccd(text: string): DlpFinding[] {
  const out: DlpFinding[] = [];
  for (const { start, end, m } of matches(/(?<![\d.,])(\d{12}|\d{9})(?![\d.,]*\d)/g, text)) {
    const digits = m[1]!;
    const ctx = near(text, start, end);
    if (digits.length === 12) {
      // Citizen ID: province code + century/gender digit 0–3, unless it reads as a bank account;
      // or explicitly labelled.
      const labelled = /cccd|can cuoc|dinh danh/.test(ctx);
      const shaped = PROVINCE_CODES.has(digits.slice(0, 3)) && /[0-3]/.test(digits[3]!);
      if (labelled || (shaped && !BANK_KEYWORDS.test(ctx))) {
        out.push({ detector: 'cccd', start, end });
      }
    } else if (/cmnd|cmt\b|chung minh/.test(ctx)) {
      out.push({ detector: 'cccd', start, end });
    }
  }
  return out;
}

function bank(text: string): DlpFinding[] {
  const out: DlpFinding[] = [];
  const seen = new Set<number>();
  // Card numbers: 13–19 digits, optionally grouped, passing Luhn.
  for (const { start, end, m } of matches(/(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)/g, text)) {
    const digits = m[0].replace(/\D/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) {
      out.push({ detector: 'bank', start, end });
      seen.add(start);
    }
  }
  // Account numbers: 9–19 digits near "STK", "tài khoản"…
  for (const { start, end } of matches(/(?<![\d.,])\d{9,19}(?![\d.,]*\d)/g, text)) {
    if (seen.has(start)) continue;
    if (BANK_KEYWORDS.test(near(text, start, end, 40, 0)))
      out.push({ detector: 'bank', start, end });
  }
  return out;
}

function password(text: string): DlpFinding[] {
  const out: DlpFinding[] = [];
  const re =
    /(?<![\p{L}])(?:m[aậ]t\s*kh[aẩ]u|password|passwd|pass|mk|pwd)(?:\s+(?:wi-?fi|email|admin|cũ|mới))?\s*(là|:|=)\s*["'“]?([^\s"'”,;]{4,})/giu;
  for (const m of text.matchAll(re)) {
    const value = m[2]!;
    // After "là" the value must look like a password (digit or symbol), not an ordinary word.
    if (m[1]!.toLowerCase() === 'là' && !/[^\p{L}]/u.test(value)) continue;
    const start = m.index! + m[0].lastIndexOf(value);
    out.push({ detector: 'password', start, end: start + value.length });
  }
  return out;
}

const SECRET_PATTERNS = [
  /sk-(?:proj-|ant-)?[A-Za-z0-9_-]{20,}/g,
  /AIza[0-9A-Za-z_-]{35}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g,
  /github_pat_[A-Za-z0-9_]{40,}/g,
  /xox[abpr]-[A-Za-z0-9-]{10,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /ya29\.[A-Za-z0-9_-]{20,}/g,
  /-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

function entropy(s: string): number {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of counts.values()) h -= (n / s.length) * Math.log2(n / s.length);
  return h;
}

function secret(text: string): DlpFinding[] {
  const out: DlpFinding[] = [];
  const covered: [number, number][] = [];
  for (const re of SECRET_PATTERNS) {
    for (const { start, end } of matches(re, text)) {
      out.push({ detector: 'secret', start, end });
      covered.push([start, end]);
    }
  }
  // Other high-entropy tokens (32+ characters mixing lower case, upper case and digits),
  // except inside links (document ids in Google Drive/Docs URLs).
  for (const { start, end, m } of matches(/[A-Za-z0-9+_=-]{32,}/g, text)) {
    if (covered.some(([a, b]) => start < b && end > a)) continue;
    const wordStart = Math.max(text.lastIndexOf(' ', start), text.lastIndexOf('\n', start)) + 1;
    if (/:\/\/|^www\./.test(text.slice(wordStart, end))) continue;
    const t = m[0];
    const classes = [/[a-z]/, /[A-Z]/, /\d/].filter((r) => r.test(t)).length;
    if (classes === 3 && entropy(t) >= 3.8) out.push({ detector: 'secret', start, end });
  }
  return out;
}

/** Student IDs: 8–10 digits labelled as such, together with grades or personal details. */
const STUDENT_ID_LABEL = /msv|ma sinh vien|ma sv|mssv|ma so sinh vien|ma can bo|ma nhan su|ma nv\b/;
const PERSONAL_FIELDS =
  /diem|ngay sinh|que quan|dia chi|so dien thoai|sdt|email|gioi tinh|xep loai|hoc luc|luong|cccd/;

function studentData(text: string): DlpFinding[] {
  const folded = fold(text);
  const ids = [...matches(/(?<!\d)\d{8,10}(?!\d)/g, text)];
  if (ids.length === 0) return [];
  const labelled = STUDENT_ID_LABEL.test(folded);
  const personal = PERSONAL_FIELDS.test(folded);
  // A table: several lines each with an ID-like number and a separator.
  const tableRows = text
    .split('\n')
    .filter((l) => /(?<!\d)\d{8,10}(?!\d)/.test(l) && /[\t|,;]/.test(l)).length;
  if ((labelled && personal) || (tableRows >= 3 && (labelled || personal))) {
    return ids.map(({ start, end }) => ({ detector: 'student_data' as const, start, end }));
  }
  return [];
}

function confidential(text: string): DlpFinding[] {
  const out: DlpFinding[] = [];
  // Classification marks in capitals (not "bảo mật"/"bí mật" or the ordinary word "mật").
  const marks = [
    /(?<![\p{L}])(?:TUYỆT MẬT|TỐI MẬT)(?![\p{L}])/gu,
    /^[ \t]*MẬT[ \t.]*$/gmu,
    /độ mật\s*:\s*\p{L}+(?:\s\p{L}+)?/giu,
    /lưu hành nội bộ|không (?:được )?phổ biến ra (?:ngoài|bên ngoài)/giu,
  ];
  for (const re of marks) {
    for (const { start, end } of matches(re, text))
      out.push({ detector: 'confidential', start, end });
  }
  return out;
}

const DETECTORS: Record<DlpDetector, (text: string) => DlpFinding[]> = {
  cccd,
  bank,
  password,
  secret,
  student_data: studentData,
  confidential,
};

/** All findings, without overlaps (earlier detector in DLP_DETECTORS order wins). */
export function scanText(text: string): DlpFinding[] {
  const nfc = text.normalize('NFC');
  const all: DlpFinding[] = [];
  for (const d of DLP_DETECTORS) {
    for (const f of DETECTORS[d](nfc)) {
      if (!all.some((g) => f.start < g.end && f.end > g.start)) all.push(f);
    }
  }
  return all.sort((a, b) => a.start - b.start);
}

// ---------------------------------------------------------------------------
// Policy

const dlpActionSchema = z.enum(DLP_ACTIONS);

export const dlpOverrideSchema = z.object({
  detector: z.enum(DLP_DETECTORS),
  action: z.enum(DLP_ACTIONS),
  /** Applies to staff of these units (sub-units included); empty = everyone. */
  departmentIds: z.array(z.string().min(1).max(64)).max(50),
  /** Applies to these roles; empty = every role. */
  roles: z.array(z.enum(ROLES)).max(ROLES.length),
  note: z.string().trim().max(200),
});
export type DlpOverride = z.infer<typeof dlpOverrideSchema>;

export const dlpPolicySchema = z
  .object({
    defaults: z.object({
      cccd: dlpActionSchema,
      bank: dlpActionSchema,
      password: dlpActionSchema,
      secret: dlpActionSchema,
      student_data: dlpActionSchema,
      confidential: dlpActionSchema,
    }),
    /** First matching override wins over the default. */
    overrides: z.array(dlpOverrideSchema).max(100),
  })
  .strict();
export type DlpPolicy = z.infer<typeof dlpPolicySchema>;

export const DEFAULT_DLP_POLICY: DlpPolicy = { defaults: DEFAULT_DLP_ACTIONS, overrides: [] };

export function actionFor(
  policy: DlpPolicy,
  detector: DlpDetector,
  user: { role: Role; departmentPath: string[] },
): DlpAction {
  const o = policy.overrides.find(
    (r) =>
      r.detector === detector &&
      (r.roles.length === 0 || r.roles.includes(user.role)) &&
      (r.departmentIds.length === 0 ||
        r.departmentIds.some((d) => user.departmentPath.includes(d))),
  );
  return o?.action ?? policy.defaults[detector];
}

export interface DlpDecision {
  /** The strictest action among the findings. */
  action: DlpAction;
  /** Count of findings per detector. */
  counts: Partial<Record<DlpDetector, number>>;
  /** Detectors per resulting action. */
  byAction: Partial<Record<DlpAction, DlpDetector[]>>;
}

export function decide(
  findings: DlpFinding[],
  policy: DlpPolicy,
  user: { role: Role; departmentPath: string[] },
): DlpDecision {
  const counts: Partial<Record<DlpDetector, number>> = {};
  for (const f of findings) counts[f.detector] = (counts[f.detector] ?? 0) + 1;
  const byAction: Partial<Record<DlpAction, DlpDetector[]>> = {};
  let action: DlpAction = 'allow';
  for (const d of Object.keys(counts) as DlpDetector[]) {
    const a = actionFor(policy, d, user);
    (byAction[a] ??= []).push(d);
    if (SEVERITY[a] > SEVERITY[action]) action = a;
  }
  return { action, counts, byAction };
}

/**
 * Replaces the findings of `detectors` with numbered placeholders ([CCCD_1]…); the same value
 * keeps the same placeholder. `mapping` continues across calls for one request.
 */
export function maskText(
  text: string,
  findings: DlpFinding[],
  detectors: DlpDetector[],
  mapping: Map<string, string> = new Map(),
): string {
  const nfc = text.normalize('NFC');
  let out = '';
  let pos = 0;
  const counters = new Map<DlpDetector, number>();
  for (const [placeholder] of mapping) {
    const m = placeholder.match(/^\[([A-Z]+)_(\d+)\]$/);
    const d = DLP_DETECTORS.find((x) => PLACEHOLDER[x] === m?.[1]);
    if (d && m) counters.set(d, Math.max(counters.get(d) ?? 0, Number(m[2])));
  }
  for (const f of findings) {
    if (!detectors.includes(f.detector)) continue;
    const value = nfc.slice(f.start, f.end);
    let placeholder = [...mapping].find(([, v]) => v === value)?.[0];
    if (!placeholder) {
      const n = (counters.get(f.detector) ?? 0) + 1;
      counters.set(f.detector, n);
      placeholder = `[${PLACEHOLDER[f.detector]}_${n}]`;
      mapping.set(placeholder, value);
    }
    out += nfc.slice(pos, f.start) + placeholder;
    pos = f.end;
  }
  return out + nfc.slice(pos);
}

/** Puts the original values back (answers shown to the user who typed them). */
export function unmaskText(
  text: string,
  mapping: Map<string, string> | Record<string, string>,
): string {
  const entries = mapping instanceof Map ? [...mapping] : Object.entries(mapping);
  let out = text;
  for (const [placeholder, value] of entries) out = out.split(placeholder).join(value);
  return out;
}

/**
 * Restores placeholders in a streamed answer: text is released as it arrives, except a
 * trailing "[…" that may be the start of a placeholder split across chunks.
 */
export function createUnmasker(mapping: Map<string, string>) {
  let pending = '';
  return {
    push(delta: string): string {
      if (mapping.size === 0) return delta;
      pending += delta;
      const open = pending.lastIndexOf('[');
      let cut = pending.length;
      if (open >= 0 && !pending.includes(']', open) && pending.length - open <= 16) cut = open;
      const ready = pending.slice(0, cut);
      pending = pending.slice(cut);
      return unmaskText(ready, mapping);
    },
    flush(): string {
      const rest = unmaskText(pending, mapping);
      pending = '';
      return rest;
    },
  };
}

export const dlpTestRequestSchema = z.object({ text: z.string().max(100_000) }).strict();
export const dlpTestResponseSchema = z.object({
  action: z.enum(DLP_ACTIONS),
  findings: z.array(z.object({ detector: z.enum(DLP_DETECTORS), action: z.enum(DLP_ACTIONS) })),
  masked: z.string(),
});
export type DlpTestResponse = z.infer<typeof dlpTestResponseSchema>;
export const dlpPolicyViewSchema = z.object({
  policy: dlpPolicySchema,
  updatedBy: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type DlpPolicyView = z.infer<typeof dlpPolicyViewSchema>;

/** Status 428 body when the user must confirm before sending (warn). */
export const DLP_CONFIRM_STATUS = 428;
