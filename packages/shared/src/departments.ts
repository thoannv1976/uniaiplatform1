import { z } from 'zod';
import { missingColumns, type ImportIssue, type ParsedCsv } from './csv.js';

export const DEPARTMENT_TYPES = ['university', 'faculty', 'office', 'division', 'other'] as const;
export type DepartmentType = (typeof DEPARTMENT_TYPES)[number];

export const DEPARTMENT_TYPE_LABELS_VI: Record<DepartmentType, string> = {
  university: 'Trường',
  faculty: 'Khoa',
  office: 'Phòng/Ban',
  division: 'Bộ môn',
  other: 'Đơn vị khác',
};

/** Values accepted in the "loai" CSV column. */
const CSV_TYPE: Record<string, DepartmentType> = {
  truong: 'university',
  khoa: 'faculty',
  phong: 'office',
  ban: 'office',
  bo_mon: 'division',
  khac: 'other',
};
const CSV_TYPE_BY_VALUE = Object.fromEntries(
  Object.entries(CSV_TYPE).map(([k, v]) => [v, k]),
) as Record<DepartmentType, string>;

/** Department codes double as Firestore document ids. */
export const departmentCodeSchema = z
  .string()
  .trim()
  .transform((s) => s.toUpperCase())
  .pipe(
    z
      .string()
      .regex(/^[A-Z0-9_-]{1,32}$/, 'Mã đơn vị chỉ gồm chữ, số, "_" hoặc "-" (tối đa 32 ký tự)'),
  );

export const departmentSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.enum(DEPARTMENT_TYPES),
  parentId: z.string().nullable(),
  /** Ancestor ids from the root down to and including this department. */
  path: z.array(z.string()),
  status: z.enum(['active', 'archived']),
});
export type Department = z.infer<typeof departmentSchema>;
export const departmentListResponseSchema = z.object({ departments: z.array(departmentSchema) });

const nameSchema = z.string().trim().min(1, 'Tên đơn vị không được trống').max(200);

export const createDepartmentRequestSchema = z
  .object({
    id: departmentCodeSchema,
    name: nameSchema,
    type: z.enum(DEPARTMENT_TYPES),
    parentId: departmentCodeSchema.nullable(),
  })
  .strict();
export type CreateDepartmentRequest = z.infer<typeof createDepartmentRequestSchema>;

export const updateDepartmentRequestSchema = z
  .object({
    name: nameSchema.optional(),
    type: z.enum(DEPARTMENT_TYPES).optional(),
    parentId: departmentCodeSchema.nullable().optional(),
    status: z.enum(['active', 'archived']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateDepartmentRequest = z.infer<typeof updateDepartmentRequestSchema>;

export const DEPARTMENT_CSV_COLUMNS = ['ma_don_vi', 'ten_don_vi', 'loai', 'ma_don_vi_cha'] as const;

export interface DepartmentImportRow {
  line: number;
  id: string;
  name: string;
  type: DepartmentType;
  parentId: string | null;
}

/** Validates each CSV row on its own; tree checks (parents, cycles) happen in the store. */
export function parseDepartmentRows(parsed: ParsedCsv): {
  rows: DepartmentImportRow[];
  issues: ImportIssue[];
} {
  const missing = missingColumns(parsed, ['ma_don_vi', 'ten_don_vi', 'loai']);
  if (missing.length) {
    return { rows: [], issues: [{ line: 1, message: `Thiếu cột: ${missing.join(', ')}` }] };
  }
  const rows: DepartmentImportRow[] = [];
  const issues: ImportIssue[] = [];
  const seen = new Map<string, number>();
  for (const { line, values } of parsed.rows) {
    const rowIssues: ImportIssue[] = [];
    const id = departmentCodeSchema.safeParse(values.ma_don_vi);
    const name = nameSchema.safeParse(values.ten_don_vi);
    const type = CSV_TYPE[(values.loai ?? '').toLowerCase()];
    const parentRaw = values.ma_don_vi_cha ?? '';
    const parent = parentRaw ? departmentCodeSchema.safeParse(parentRaw) : null;
    if (!id.success) {
      rowIssues.push({ line, column: 'ma_don_vi', message: id.error.issues[0]?.message ?? '' });
    } else {
      const first = seen.get(id.data);
      if (first)
        rowIssues.push({ line, column: 'ma_don_vi', message: `Trùng mã với dòng ${first}` });
      else seen.set(id.data, line);
    }
    if (!name.success) {
      rowIssues.push({ line, column: 'ten_don_vi', message: name.error.issues[0]?.message ?? '' });
    }
    if (!type) {
      rowIssues.push({
        line,
        column: 'loai',
        message: `Loại phải là: ${Object.keys(CSV_TYPE).join(', ')}`,
      });
    }
    if (parent && !parent.success) {
      rowIssues.push({
        line,
        column: 'ma_don_vi_cha',
        message: parent.error.issues[0]?.message ?? '',
      });
    }
    if (rowIssues.length || !id.success || !name.success || !type) {
      issues.push(...rowIssues);
      continue;
    }
    rows.push({
      line,
      id: id.data,
      name: name.data,
      type,
      parentId: parent?.success ? parent.data : null,
    });
  }
  return { rows, issues };
}

export function departmentToCsvRow(d: Department): Record<string, string> {
  return {
    ma_don_vi: d.id,
    ten_don_vi: d.name,
    loai: CSV_TYPE_BY_VALUE[d.type],
    ma_don_vi_cha: d.parentId ?? '',
  };
}
