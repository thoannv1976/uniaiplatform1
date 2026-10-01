/**
 * Creates (or resets) a break-glass email + password login in Firebase Authentication and
 * marks the email as verified (ADR 0004). The password is typed twice, hidden, in Cloud Shell;
 * it is never passed on the command line, logged, or stored anywhere but Firebase Auth.
 *
 *   pnpm ops:create-login --email admin@example.com           # preview
 *   pnpm ops:create-login --email admin@example.com --yes     # asks for the password
 *
 * Afterwards grant a role with ops:grant-role (--allow-outside-domain for non-school emails)
 * and add the email to the EXTRA_ALLOWED_EMAILS GitHub variable.
 */
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { getAuth } from 'firebase-admin/auth';
import { getAdminApp } from '../admin.js';
import { normaliseEmail } from '../users.js';

/** Returns a Vietnamese reason when the password is too weak, otherwise null. */
export function passwordProblem(password: string, email: string): string | null {
  if (password.length < 12) return 'Mật khẩu phải có ít nhất 12 ký tự.';
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((r) =>
    r.test(password),
  ).length;
  if (classes < 3)
    return 'Mật khẩu cần ít nhất 3 trong 4 loại: chữ thường, chữ hoa, số, ký tự đặc biệt.';
  const local = email.split('@')[0] ?? '';
  if (local.length >= 4 && password.toLowerCase().includes(local.toLowerCase())) {
    return 'Mật khẩu không được chứa phần tên của email.';
  }
  if (/^(abc|123|qwe|pass|admin)/i.test(password))
    return 'Mật khẩu quá dễ đoán, hãy chọn mật khẩu khác.';
  return null;
}

async function askHidden(question: string): Promise<string> {
  process.stdout.write(question);
  const muted = new Writable({ write: (_chunk, _enc, cb) => cb() });
  const rl = createInterface({ input: process.stdin, output: muted, terminal: true });
  try {
    return await rl.question('');
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

async function readPassword(): Promise<string> {
  // For automated tests only; people should always type it.
  if (process.env.LOGIN_PASSWORD) return process.env.LOGIN_PASSWORD;
  const first = await askHidden('Nhập mật khẩu (không hiển thị): ');
  const second = await askHidden('Nhập lại mật khẩu: ');
  if (first !== second) throw new Error('Hai lần nhập mật khẩu không khớp.');
  return first;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      email: { type: 'string' },
      project: { type: 'string', default: process.env.GCLOUD_PROJECT ?? 'uniaiplatform1' },
      yes: { type: 'boolean', default: false },
    },
  });
  const email = values.email ? normaliseEmail(values.email) : '';
  if (!/^[^\s@/]+@[^\s@/]+\.[^\s@/]+$/.test(email)) {
    console.error('Cách dùng: --email <email> [--yes]');
    return 2;
  }
  process.env.GCLOUD_PROJECT ??= values.project;
  const auth = getAuth(getAdminApp(values.project));
  const existing = await auth.getUserByEmail(email).catch(() => null);
  console.log(
    `${existing ? 'Sẽ ĐẶT LẠI mật khẩu' : 'Sẽ TẠO tài khoản'} đăng nhập email + mật khẩu cho ${email} ` +
      `(đánh dấu email đã xác minh) – project ${values.project}.`,
  );
  if (!values.yes) {
    console.log('Chế độ xem trước: chưa thay đổi gì. Thêm --yes để thực hiện.');
    return 0;
  }

  const password = await readPassword();
  const problem = passwordProblem(password, email);
  if (problem) {
    console.error(problem);
    return 2;
  }
  const user = existing
    ? await auth.updateUser(existing.uid, { password, emailVerified: true, disabled: false })
    : await auth.createUser({ email, password, emailVerified: true });
  if (existing) await auth.revokeRefreshTokens(user.uid);
  console.log(`Xong. uid = ${user.uid}. Tiếp theo: cấp vai trò bằng pnpm ops:grant-role.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
