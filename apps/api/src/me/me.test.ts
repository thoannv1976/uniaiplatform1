import type { INestApplication } from '@nestjs/common';
import { meResponseSchema } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.factory.js';
import type { TokenVerifier, VerifiedToken } from '../auth/token-verifier.js';
import { loadConfig } from '../config.js';

/** Fake verifier: the token string is a key into this table. */
const TOKENS: Record<string, VerifiedToken> = {
  'ok-token': { uid: 'u1', email: 'gv01@ftu.edu.vn', emailVerified: true, name: 'Nguyễn Văn A' },
  'gmail-token': { uid: 'u2', email: 'someone@gmail.com', emailVerified: true },
  'unverified-token': { uid: 'u3', email: 'gv02@ftu.edu.vn', emailVerified: false },
  'no-email-token': { uid: 'u4', emailVerified: false },
};
const fakeVerifier: TokenVerifier = {
  verify: (token) => {
    const user = TOKENS[token];
    return user ? Promise.resolve(user) : Promise.reject(new Error('invalid'));
  },
};

let app: INestApplication;

beforeAll(async () => {
  app = await createApp(loadConfig({ ALLOWED_EMAIL_DOMAINS: 'ftu.edu.vn' }), {
    quiet: true,
    overrides: { tokenVerifier: fakeVerifier },
  });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

const get = (auth?: string) => {
  const req = request(app.getHttpServer()).get('/api/me');
  return auth ? req.set('Authorization', auth) : req;
};

describe('GET /api/me', () => {
  it('returns the signed-in user for a verified @ftu.edu.vn account', async () => {
    const res = await get('Bearer ok-token').expect(200);
    expect(meResponseSchema.parse(res.body)).toEqual({
      uid: 'u1',
      email: 'gv01@ftu.edu.vn',
      name: 'Nguyễn Văn A',
    });
  });

  it('returns 401 without a token or with a malformed header', async () => {
    expect((await get()).status).toBe(401);
    expect((await get('ok-token')).status).toBe(401);
    expect((await get('Basic ok-token')).status).toBe(401);
  });

  it('returns 401 for an invalid or expired token', async () => {
    const res = await get('Bearer forged');
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/không hợp lệ/);
  });

  it('returns 403 for other domains, unverified emails and tokens without email', async () => {
    for (const token of ['gmail-token', 'unverified-token', 'no-email-token']) {
      const res = await get(`Bearer ${token}`);
      expect(res.status, token).toBe(403);
      expect(res.body.message).toContain('@ftu.edu.vn');
    }
  });
});

describe('loadConfig', () => {
  it('defaults the allowed email domain to ftu.edu.vn', () => {
    expect(loadConfig({}).allowedEmailDomains).toEqual(['ftu.edu.vn']);
  });

  it('rejects an empty domain list', () => {
    expect(() => loadConfig({ ALLOWED_EMAIL_DOMAINS: ' , ' })).toThrow('ALLOWED_EMAIL_DOMAINS');
  });
});
