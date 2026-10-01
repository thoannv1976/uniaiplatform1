export const ROLES = ['super_admin', 'ai_admin', 'unit_admin', 'user', 'auditor'] as const;
export type Role = (typeof ROLES)[number];

export const ROLE_LABELS_VI: Record<Role, string> = {
  super_admin: 'Quản trị hệ thống',
  ai_admin: 'Quản trị AI',
  unit_admin: 'Quản trị đơn vị',
  user: 'Người dùng',
  auditor: 'Kiểm toán',
};
