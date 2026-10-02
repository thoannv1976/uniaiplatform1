import { Controller, Get, type INestApplication } from '@nestjs/common';
import { MemorySecretStore, MockProvider, type ProviderConnection } from '@uniai/ai-providers';
import { AuditStore, clearFirestoreEmulator, getDb, seed, UserStore } from '@uniai/firestore';
import type { Role, UserStatus } from '@uniai/shared';
import request from 'supertest';
import { createApp } from '../app.factory.js';
import type { IdentityAdmin, TokenVerifier } from '../auth/token-verifier.js';
import { loadConfig } from '../config.js';

/** Endpoint without @Roles – the global guard must deny it. */
@Controller('api/test')
export class UnguardedTestController {
  @Get('unguarded')
  unguarded() {
    return { ok: true };
  }
}

/**
 * Fake verifier for tests: a token is "<uid>|<email>|<verified>", e.g.
 * "u1|gv01@ftu.edu.vn|1". Real tokens are covered by me.emulator.test.ts.
 */
export const fakeVerifier: TokenVerifier = {
  verify: (token) => {
    const [uid, email, verified] = token.split('|');
    if (!uid || verified === undefined) return Promise.reject(new Error('invalid'));
    return Promise.resolve({ uid, email: email || undefined, emailVerified: verified === '1' });
  },
};

export class RecordingIdentityAdmin implements IdentityAdmin {
  revoked: string[] = [];
  revokeSessions(uid: string) {
    this.revoked.push(uid);
    return Promise.resolve();
  }
}

export const tokenFor = (uid: string, email = `${uid}@ftu.edu.vn`, verified = true) =>
  `Bearer ${uid}|${email}|${verified ? 1 : 0}`;

export async function startApp(env: Record<string, string> = {}) {
  const identity = new RecordingIdentityAdmin();
  const secrets = new MemorySecretStore();
  /** Every adapter the API built, with the key it was given; all of them are mocks. */
  const connections: ProviderConnection[] = [];
  const app = await createApp(
    loadConfig({
      ALLOWED_EMAIL_DOMAINS: 'ftu.edu.vn',
      EXTRA_ALLOWED_EMAILS: 'breakglass@gmail.com',
      GCLOUD_PROJECT: 'demo-uniai',
      ENABLE_MOCK_PROVIDER: 'true',
      ...env,
    }),
    {
      quiet: true,
      overrides: {
        tokenVerifier: fakeVerifier,
        identityAdmin: identity,
        secretStore: secrets,
        providerFactory: (c) => {
          connections.push(c);
          return new MockProvider();
        },
        extraControllers: [UnguardedTestController],
      },
    },
  );
  await app.init();
  return { app, identity, secrets, connections };
}

export const users = () => new UserStore(getDb());
export const audit = () => new AuditStore(getDb());
/** Empties the emulator and loads the sample department tree (FTU > KTQT > KTQT-KTVM, QTKD, QLDT). */
export async function resetData() {
  await clearFirestoreEmulator();
  await seed(getDb());
}

/** Creates an existing user with the given role/status (via the directory, like production). */
export async function givenUser(
  app: INestApplication,
  uid: string,
  role: Role,
  status: UserStatus = 'active',
  extra: { departmentId?: string | null; scopeDepartmentId?: string | null } = {},
) {
  await users().upsertDirectory({
    email: `${uid}@ftu.edu.vn`,
    role,
    status,
    departmentId: extra.departmentId ?? null,
    scopeDepartmentId: extra.scopeDepartmentId ?? null,
    updatedBy: 'test',
  });
  await request(app.getHttpServer()).get('/api/me').set('Authorization', tokenFor(uid));
}
