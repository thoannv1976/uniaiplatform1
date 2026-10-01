import { z } from 'zod';
import { missingColumns, type ImportIssue, type ParsedCsv } from './csv.js';
import { departmentCodeSchema } from './departments.js';
import { ROLES, type Role } from './roles.js';
import { USER_STATUSES, type UserStatus } from './users.js';

export const QUOTA_TIER_IDS = ['standard', 'power', 'research'] as const;
export type QuotaTierId = (typeof QUOTA_TIER_IDS)[number];

export const QUOTA_TIER_LABELS_VI: Record<QuotaTierId, string> = {
  standard: 'Tiêu chuẩn',
  power: 'Sử dụng nhiều',
  research: 'Nghiên cứu',
};

/** userDirectory/{email}: the university's record of a staff member (ADR 0003). */
export const directoryEntrySchema = z.object({
  email: z.string(),
  /** Firebase uid once the person has signed in. */
  uid: z.string().nullable(),
  fullName: z.string().nullable(),
  staffCode: z.string().nullable(),
  title: z.string().nullable(),
  departmentId: z.string().nullable(),
  departmentPath: z.array(z.string()),
  role: z.enum(ROLES),
  status: z.enum(USER_STATUSES),
  quotaTierId: z.enum(QUOTA_TIER_IDS),
  scopeDepartmentId: z.string().nullable(),
  activatedAt: z.string().nullable(),
  lockedAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
  updatedBy: z.string().nullable(),
});
export type DirectoryEntry = z.infer<typeof directoryEntrySchema>;
export const directoryListResponseSchema = z.object({ entries: z.array(directoryEntrySchema) });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .transform((s) => (s === '' ? null : s))
    .nullable();

/** PATCH /api/admin/directory/:email. Unit admins may not set role/scope. */
export const updateDirectoryRequestSchema = z
  .object({
    fullName: optionalText(200).optional(),
    staffCode: optionalText(50).optional(),
    title: optionalText(200).optional(),
    departmentId: departmentCodeSchema.nullable().optional(),
    quotaTierId: z.enum(QUOTA_TIER_IDS).optional(),
    status: z.enum(USER_STATUSES).optional(),
    role: z.enum(ROLES).optional(),
    scopeDepartmentId: departmentCodeSchema.nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateDirectoryRequest = z.infer<typeof updateDirectoryRequestSchema>;

export const importRequestSchema = z.object({
  csv: z.string().min(1, 'Tệp CSV trống').max(5_000_000, 'Tệp CSV quá lớn (tối đa 5 MB)'),
  dryRun: z.boolean().default(true),
});

export const importIssueSchema = z.object({
  line: z.number(),
  column: z.string().optional(),
  message: z.string(),
});

export const importResultSchema = z.object({
  dryRun: z.boolean(),
  applied: z.boolean(),
  total: z.number(),
  created: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  issues: z.array(importIssueSchema),
});
export type ImportResult = z.infer<typeof importResultSchema>;

export const USER_CSV_COLUMNS = [
  'email',
  'ho_ten',
  'ma_can_bo',
  'ma_don_vi',
  'chuc_vu',
  'vai_tro',
  'nhom_dinh_muc',
  'trang_thai',
  'don_vi_quan_ly',
] as const;

export interface DirectoryImportRow {
  line: number;
  email: string;
  fullName: string | null;
  staffCode: string | null;
  title: string | null;
  departmentId: string | null;
  role: Role;
  quotaTierId: QuotaTierId;
  status: UserStatus;
  scopeDepartmentId: string | null;
}

const emailSchema = z.string().trim().toLowerCase().pipe(z.email('Email không hợp lệ'));

/**
 * Validates each row on its own (domain, enums, duplicates). Whether departments exist and
 * whether the importer may set a role is checked by the store, which knows the tree and caller.
 */
export function parseDirectoryRows(
  parsed: ParsedCsv,
  isAllowedEmail: (email: string) => boolean,
): { rows: DirectoryImportRow[]; issues: ImportIssue[] } {
  const missing = missingColumns(parsed, ['email']);
  if (missing.length) {
    return { rows: [], issues: [{ line: 1, message: `Thiếu cột: ${missing.join(', ')}` }] };
  }
  const rows: DirectoryImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  for (const { line, values: v } of parsed.rows) {
    const rowIssues: ImportIssue[] = [];
    const email = emailSchema.safeParse(v.email ?? '');
    if (!email.success) rowIssues.push({ line, column: 'email', message: 'Email không hợp lệ' });
    else if (!isAllowedEmail(email.data)) {
      rowIssues.push({ line, column: 'email', message: 'Email không thuộc tên miền của trường' });
    } else {
      const first = seen.get(email.data);
      if (first)
        rowIssues.push({ line, column: 'email', message: `Trùng email với dòng ${first}` });
      else seen.set(email.data, line);
    }
    const dept = v.ma_don_vi ? departmentCodeSchema.safeParse(v.ma_don_vi) : null;
    if (dept && !dept.success)
      rowIssues.push({ line, column: 'ma_don_vi', message: dept.error.issues[0]?.message ?? '' });
    const scope = v.don_vi_quan_ly ? departmentCodeSchema.safeParse(v.don_vi_quan_ly) : null;
    if (scope && !scope.success) {
      rowIssues.push({
        line,
        column: 'don_vi_quan_ly',
        message: scope.error.issues[0]?.message ?? '',
      });
    }
    const role = (v.vai_tro || 'user') as Role;
    if (!ROLES.includes(role))
      rowIssues.push({ line, column: 'vai_tro', message: `Vai trò phải là: ${ROLES.join(', ')}` });
    const tier = (v.nhom_dinh_muc || 'standard') as QuotaTierId;
    if (!QUOTA_TIER_IDS.includes(tier)) {
      rowIssues.push({
        line,
        column: 'nhom_dinh_muc',
        message: `Nhóm định mức phải là: ${QUOTA_TIER_IDS.join(', ')}`,
      });
    }
    const status = (v.trang_thai || 'active') as UserStatus;
    if (status !== 'active' && status !== 'locked') {
      rowIssues.push({ line, column: 'trang_thai', message: 'Trạng thái phải là: active, locked' });
    }
    if (role === 'unit_admin' && !scope) {
      rowIssues.push({
        line,
        column: 'don_vi_quan_ly',
        message: 'Quản trị đơn vị cần có đơn vị quản lý',
      });
    }
    const text = (s: string | undefined, max: number, column: string) => {
      const t = (s ?? '').trim();
      if (t.length > max) rowIssues.push({ line, column, message: `Tối đa ${max} ký tự` });
      return t === '' ? null : t;
    };
    const fullName = text(v.ho_ten, 200, 'ho_ten');
    const staffCode = text(v.ma_can_bo, 50, 'ma_can_bo');
    const title = text(v.chuc_vu, 200, 'chuc_vu');

    if (rowIssues.length) {
      issues.push(...rowIssues);
      continue;
    }
    rows.push({
      line,
      email: (email as { data: string }).data,
      fullName,
      staffCode,
      title,
      departmentId: dept?.success ? dept.data : null,
      role,
      quotaTierId: tier,
      status,
      scopeDepartmentId: scope?.success ? scope.data : null,
    });
  }
  return { rows, issues };
}

export function directoryToCsvRow(e: DirectoryEntry): Record<string, string> {
  return {
    email: e.email,
    ho_ten: e.fullName ?? '',
    ma_can_bo: e.staffCode ?? '',
    ma_don_vi: e.departmentId ?? '',
    chuc_vu: e.title ?? '',
    vai_tro: e.role,
    nhom_dinh_muc: e.quotaTierId,
    trang_thai: e.status === 'pending' ? 'active' : e.status,
    don_vi_quan_ly: e.scopeDepartmentId ?? '',
  };
}
