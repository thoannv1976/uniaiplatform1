import type { INestApplication } from '@nestjs/common';
import { clearFirestoreEmulator, getAdminApp } from '@uniai/firestore';
import { getAuth } from 'firebase-admin/auth';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.factory.js';
import { loadConfig } from '../config.js';

const AUTH_HOST = process.env.FIREBASE_AUTH_EMULATOR_HOST;

/** Signs in against the Auth emulator REST API and returns a real (emulator-signed) ID token. */
async function idTokenFor(email: string, emailVerified: boolean): Promise<string> {
  const password = 'mat-khau-test-123';
  const auth = getAuth(getAdminApp());
  await auth.createUser({ email, password, emailVerified }).catch(() => undefined);
  const res = await fetch(
    `http://${AUTH_HOST}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=fake-key`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password, returnSecureToken: true }),
    },
  );
  const body = (await res.json()) as { idToken?: string };
  if (!body.idToken) throw new Error(`Không lấy được ID token cho ${email}`);
  return body.idToken;
}

let app: INestApplication;

beforeAll(async () => {
  if (!AUTH_HOST)
    throw new Error('Cần chạy trong firebase emulators:exec (thiếu FIREBASE_AUTH_EMULATOR_HOST)');
  await clearFirestoreEmulator();
  app = await createApp(loadConfig({ ALLOWED_EMAIL_DOMAINS: 'ftu.edu.vn' }), { quiet: true });
  await app.init();
});

afterAll(async () => {
  await app?.close();
});

describe('real Firebase Auth emulator tokens', () => {
  it('provisions a verified @ftu.edu.vn user as pending', async () => {
    const token = await idTokenFor('emu-gv01@ftu.edu.vn', true);
    const res = await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(200);
    expect(res.body).toMatchObject({ email: 'emu-gv01@ftu.edu.vn', status: 'pending' });
  });

  it('rejects a real ID token from another domain', async () => {
    const token = await idTokenFor('emu-user@gmail.com', true);
    await request(app.getHttpServer())
      .get('/api/me')
      .set('Authorization', `Bearer ${token}`)
      .expect(403);
  });

  it('revokes refresh tokens through the real Firebase Admin SDK', async () => {
    const user = await getAuth(getAdminApp()).getUserByEmail('emu-gv01@ftu.edu.vn');
    await getAuth(getAdminApp()).revokeRefreshTokens(user.uid);
    const after = await getAuth(getAdminApp()).getUser(user.uid);
    expect(after.tokensValidAfterTime).toBeTruthy();
  });
});
