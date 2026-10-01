/**
 * Grants a role to an email address (writes userDirectory/{email}; syncs an existing profile).
 * Used by Claude Cowork in Cloud Shell to create the first Super Admin (runbook M2).
 *
 *   pnpm ops:grant-role --email a@ftu.edu.vn --role super_admin --database staging          # preview
 *   pnpm ops:grant-role --email a@ftu.edu.vn --role super_admin --database staging --yes    # apply
 *   (break-glass admin outside @ftu.edu.vn: add --allow-outside-domain, see ADR 0004)
 */
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { isAllowedEmail, parseDomainList, ROLES, type Role } from '@uniai/shared';
import { getDb, isEmulator } from '../admin.js';
import { AuditStore } from '../audit.js';
import { normaliseEmail, UserStore } from '../users.js';

function operator(): string {
  if (isEmulator()) return 'ops:emulator';
  try {
    return `ops:${execFileSync('gcloud', ['config', 'get-value', 'account'], { encoding: 'utf8' }).trim()}`;
  } catch {
    return 'ops:unknown';
  }
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      role: { type: 'string' },
      database: { type: 'string' },
      project: { type: 'string', default: process.env.GCLOUD_PROJECT ?? 'uniaiplatform1' },
      domains: { type: 'string', default: 'ftu.edu.vn' },
      yes: { type: 'boolean', default: false },
      'allow-outside-domain': { type: 'boolean', default: false },
    },
  });

  const email = values.email ? normaliseEmail(values.email) : '';
  const role = values.role as Role;
  if (!email || !ROLES.includes(role) || !values.database) {
    console.error(
      'Cách dùng: --email <email> --role <' +
        ROLES.join('|') +
        '> --database <(default)|staging> [--yes]',
    );
    return 2;
  }
  if (!isAllowedEmail(email, parseDomainList(values.domains))) {
    if (!values['allow-outside-domain']) {
      console.error(
        `Email ${email} không thuộc tên miền được phép (${values.domains}). ` +
          'Chỉ với tài khoản quản trị dự phòng (ADR 0004) mới thêm --allow-outside-domain.',
      );
      return 2;
    }
    console.log(
      `Lưu ý: ${email} nằm ngoài tên miền trường. Nhớ thêm email này vào biến GitHub EXTRA_ALLOWED_EMAILS ` +
        'rồi chạy lại Deploy, nếu không API vẫn từ chối.',
    );
  }

  process.env.GCLOUD_PROJECT ??= values.project;
  const db = getDb({ projectId: values.project, databaseId: values.database });
  const target = `${isEmulator() ? 'EMULATOR' : `project ${values.project}`}, database ${values.database}`;
  console.log(`Sẽ cấp vai trò ${role} (trạng thái active) cho ${email} – ${target}.`);
  if (!values.yes) {
    console.log('Chế độ xem trước: chưa thay đổi gì. Thêm --yes để thực hiện.');
    return 0;
  }

  const actor = operator();
  const { syncedUid } = await new UserStore(db).upsertDirectory({
    email,
    role,
    status: 'active',
    departmentId: null,
    scopeDepartmentId: null,
    updatedBy: actor,
  });
  await new AuditStore(db).append({
    event: 'ADMIN_CHANGE',
    actor,
    target: syncedUid ?? email,
    metadata: { action: 'grant_role', email, role, database: values.database },
  });
  console.log(
    syncedUid
      ? `Đã cấp. Hồ sơ hiện có (uid ${syncedUid}) đã được cập nhật.`
      : 'Đã cấp. Vai trò có hiệu lực khi người dùng đăng nhập lần đầu.',
  );
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err);
      process.exit(1);
    },
  );
}
