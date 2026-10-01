import { getAuth } from 'firebase-admin/auth';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminApp, getDb } from '../admin.js';
import { clearFirestoreEmulator } from '../testing.js';
import { UserStore } from '../users.js';
import { main as createLogin, passwordProblem } from './create-login.js';
import { main as grantRole } from './grant-role.js';

const STRONG = 'Ngoai-Thuong#2026';

beforeEach(async () => {
  await clearFirestoreEmulator();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  delete process.env.LOGIN_PASSWORD;
  vi.restoreAllMocks();
});

describe('passwordProblem', () => {
  it('rejects short, simple and guessable passwords', () => {
    expect(passwordProblem('Abc@123456', 'a@gmail.com')).toMatch(/12 ký tự/);
    expect(passwordProblem('alllowercaseonly', 'a@gmail.com')).toMatch(/3 trong 4/);
    expect(passwordProblem('Hoanganh#2026x', 'hoanganh@gmail.com')).toMatch(/tên của email/);
    expect(passwordProblem('Admin#2026-xyz', 'a@gmail.com')).toMatch(/dễ đoán/);
    expect(passwordProblem(STRONG, 'a@gmail.com')).toBeNull();
  });
});

describe('ops:create-login', () => {
  it('previews without --yes, then creates a verified email/password user', async () => {
    const email = `bg-${Date.now()}@gmail.com`;
    expect(await createLogin(['--email', email, '--project', 'demo-uniai'])).toBe(0);
    await expect(getAuth(getAdminApp()).getUserByEmail(email)).rejects.toThrow();

    process.env.LOGIN_PASSWORD = STRONG;
    expect(await createLogin(['--email', email, '--project', 'demo-uniai', '--yes'])).toBe(0);
    const user = await getAuth(getAdminApp()).getUserByEmail(email);
    expect(user.emailVerified).toBe(true);
    expect(user.providerData.map((p) => p.providerId)).toContain('password');
  });

  it('refuses a weak password', async () => {
    process.env.LOGIN_PASSWORD = 'Abc@123456';
    expect(
      await createLogin(['--email', 'weak@gmail.com', '--project', 'demo-uniai', '--yes']),
    ).toBe(2);
    await expect(getAuth(getAdminApp()).getUserByEmail('weak@gmail.com')).rejects.toThrow();
  });
});

describe('ops:grant-role', () => {
  it('refuses emails outside the domain unless --allow-outside-domain is given', async () => {
    const base = [
      '--email',
      'bg@gmail.com',
      '--role',
      'super_admin',
      '--database',
      '(default)',
      '--yes',
    ];
    expect(await grantRole(base)).toBe(2);
    expect(await grantRole([...base, '--allow-outside-domain'])).toBe(0);
    expect(await new UserStore(getDb()).getEntry('bg@gmail.com')).toMatchObject({
      role: 'super_admin',
      status: 'active',
    });
  });
});
