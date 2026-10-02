import { Controller, Get, type INestApplication } from '@nestjs/common';
import {
  MemorySecretStore,
  MockProvider,
  type LLMProvider,
  type NormalizedChatRequest,
  type ProviderConnection,
} from '@uniai/ai-providers';
import { AuditStore, clearFirestoreEmulator, getDb, seed, UserStore } from '@uniai/firestore';
import { TERMS_VERSION, type Role, type UserStatus } from '@uniai/shared';
import request from 'supertest';
import { createApp } from '../app.factory.js';
import type { AppOverrides } from '../app.module.js';
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

export async function startApp(
  env: Record<string, string> = {},
  extra: Pick<AppOverrides, 'blobStore'> = {},
) {
  const identity = new RecordingIdentityAdmin();
  const secrets = new MemorySecretStore();
  /** Every adapter the API built, with the key it was given; all of them are mocks. */
  const connections: ProviderConnection[] = [];
  /** Every request the gateway sent to a provider. */
  const requests: NormalizedChatRequest[] = [];
  /** Providers whose (mock) adapter answers with a retryable 503, to test fallback. */
  const failing = new Set<string>();
  const app = await createApp(
    loadConfig({
      ALLOWED_EMAIL_DOMAINS: 'ftu.edu.vn',
      EXTRA_ALLOWED_EMAILS: 'breakglass@gmail.com',
      GCLOUD_PROJECT: 'demo-uniai',
      ENABLE_MOCK_PROVIDER: 'true',
      // Uploads go through the API into the Storage emulator, as in local development.
      FILE_UPLOAD_MODE: 'proxy',
      FILES_BUCKET: 'demo-uniai.appspot.com',
      ...env,
    }),
    {
      quiet: !process.env.DEBUG_APP,
      overrides: {
        tokenVerifier: fakeVerifier,
        identityAdmin: identity,
        secretStore: secrets,
        providerFactory: (c): LLMProvider => {
          connections.push(c);
          const mock = new MockProvider();
          return {
            id: c.id,
            transport: c.transport,
            stream: (req, signal) => {
              requests.push(req);
              if (failing.has(c.id)) {
                return (async function* () {
                  yield {
                    type: 'error' as const,
                    code: 'unavailable',
                    message: 'HTTP 503',
                    retryable: true,
                  };
                })();
              }
              return mock.stream(req, signal);
            },
          };
        },
        extraControllers: [UnguardedTestController],
        ...extra,
      },
    },
  );
  await app.init();
  return { app, identity, secrets, connections, requests, failing };
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
  extra: {
    departmentId?: string | null;
    scopeDepartmentId?: string | null;
    /** Accept the terms of use (default), as an active user normally has. */
    acceptTerms?: boolean;
  } = {},
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
  if (extra.acceptTerms !== false) {
    await getDb().collection('users').doc(uid).update({ termsVersion: TERMS_VERSION });
  }
}
