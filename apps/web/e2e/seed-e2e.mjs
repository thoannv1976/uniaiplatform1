// Prepares the emulators for the full-stack e2e run (called by global-setup.ts in a plain
// Node ESM process: Playwright's loader cannot load firebase-admin's ESM dependencies).
import { clearFirestoreEmulator, getAdminApp, getDb, seed, UserStore } from '@uniai/firestore';
import { getAuth } from 'firebase-admin/auth';

const [email, password] = process.argv.slice(2);
const project = process.env.GCLOUD_PROJECT ?? 'demo-uniai';

await clearFirestoreEmulator(project);
await fetch(
  `http://${process.env.FIREBASE_AUTH_EMULATOR_HOST}/emulator/v1/projects/${project}/accounts`,
  {
    method: 'DELETE',
  },
);
const db = getDb();
await seed(db);
await new UserStore(db).upsertDirectory({
  email,
  role: 'user',
  status: 'active',
  departmentId: 'QLDT',
  scopeDepartmentId: null,
  updatedBy: 'e2e',
});
await getAuth(getAdminApp(project)).createUser({
  email,
  password,
  emailVerified: true,
  displayName: 'Giảng viên E2E',
});
process.exit(0);
