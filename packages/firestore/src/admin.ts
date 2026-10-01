import { getApps, initializeApp, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

export interface FirestoreConfig {
  /** GCP project id; on Cloud Run it is detected automatically. */
  projectId?: string;
  /** Named Firestore database, e.g. "staging". Defaults to "(default)". */
  databaseId?: string;
}

let app: App | undefined;
const dbs = new Map<string, Firestore>();

export function isEmulator(): boolean {
  return Boolean(process.env.FIRESTORE_EMULATOR_HOST);
}

export function getAdminApp(projectId = process.env.GCLOUD_PROJECT): App {
  app ??= getApps()[0] ?? initializeApp(projectId ? { projectId } : undefined);
  return app;
}

export function getDb(config: FirestoreConfig = {}): Firestore {
  const databaseId = config.databaseId ?? process.env.FIRESTORE_DATABASE_ID ?? '(default)';
  let db = dbs.get(databaseId);
  if (!db) {
    const firebaseApp = getAdminApp(config.projectId);
    db =
      databaseId === '(default)'
        ? getFirestore(firebaseApp)
        : getFirestore(firebaseApp, databaseId);
    db.settings({ ignoreUndefinedProperties: true });
    dbs.set(databaseId, db);
  }
  return db;
}
