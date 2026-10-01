import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  assertFails,
  initializeTestEnvironment,
  type RulesTestEnvironment,
} from '@firebase/rules-unit-testing';
import { doc, getDoc, setDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

const rulesPath = fileURLToPath(new URL('../../../firestore.rules', import.meta.url));
let env: RulesTestEnvironment;

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8085').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-uniai-rules',
    firestore: { rules: readFileSync(rulesPath, 'utf8'), host, port: Number(port) },
  });
});

afterAll(async () => {
  await env.cleanup();
});

describe('firestore.rules', () => {
  it('denies all client reads and writes, even for signed-in users', async () => {
    const signedIn = env
      .authenticatedContext('user-1', { email: 'gv01@example.edu.vn' })
      .firestore();
    const anon = env.unauthenticatedContext().firestore();
    for (const db of [signedIn, anon]) {
      await assertFails(getDoc(doc(db, 'users/user-1')));
      await assertFails(setDoc(doc(db, 'users/user-1'), { role: 'super_admin' }));
      await assertFails(getDoc(doc(db, 'usageTransactions/t1')));
    }
  });
});
