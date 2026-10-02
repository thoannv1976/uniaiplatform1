import { z } from 'zod';
import { ROLES } from './roles.js';

export const USER_STATUSES = ['pending', 'active', 'locked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USER_STATUS_LABELS_VI: Record<UserStatus, string> = {
  pending: 'Chờ duyệt',
  active: 'Đang hoạt động',
  locked: 'Đã khóa',
};

export const roleSchema = z.enum(ROLES);
export const userStatusSchema = z.enum(USER_STATUSES);

export const userProfileSchema = z.object({
  uid: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  role: roleSchema,
  status: userStatusSchema,
  departmentId: z.string().nullable(),
  /** For unit_admin: the department they manage. */
  scopeDepartmentId: z.string().nullable(),
  createdAt: z.string(),
  lastLoginAt: z.string().nullable(),
  /** Version of the terms of use the user accepted (spec 12); null = not yet. */
  termsVersion: z.string().nullable(),
});
export type UserProfile = z.infer<typeof userProfileSchema>;

export const userListResponseSchema = z.object({ users: z.array(userProfileSchema) });

/** PATCH /api/admin/users/:uid – Super Admin only. At least one field is required. */
export const updateUserRequestSchema = z
  .object({
    role: roleSchema.optional(),
    status: userStatusSchema.optional(),
    departmentId: z.string().min(1).nullable().optional(),
    scopeDepartmentId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Cần ít nhất một trường để cập nhật' });
export type UpdateUserRequest = z.infer<typeof updateUserRequestSchema>;

export const AUDIT_EVENTS = [
  'USER_LOGIN',
  'USER_PROVISIONED',
  'AUTH_DENIED',
  'ADMIN_CHANGE',
  'QUOTA_CHANGE',
  'BUDGET_CHANGE',
  'DOCUMENT_UPLOAD',
  'AI_REQUEST',
  'MODEL_ROUTED',
  'FALLBACK_USED',
  'API_ERROR',
  'TERMS_ACCEPTED',
  'KNOWLEDGE_UPDATE',
] as const;
export type AuditEvent = (typeof AUDIT_EVENTS)[number];

export const auditLogSchema = z.object({
  id: z.string(),
  at: z.string(),
  event: z.enum(AUDIT_EVENTS),
  actor: z.string(),
  target: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
});
export type AuditLog = z.infer<typeof auditLogSchema>;
export const auditLogListResponseSchema = z.object({ logs: z.array(auditLogSchema) });
