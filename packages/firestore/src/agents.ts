import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  agentSchema,
  integrationSchema,
  type Agent,
  type Integration,
  type UpsertAgentRequest,
  type UpsertIntegrationRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

const iso = (t: unknown) => (t instanceof Timestamp ? t.toDate().toISOString() : null);

function toAgent(snap: DocumentSnapshot): Agent | null {
  const d = snap.data();
  if (!d) return null;
  const parsed = agentSchema.safeParse({
    ...d,
    id: snap.id,
    createdAt: iso(d.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(d.updatedAt) ?? new Date(0).toISOString(),
  });
  return parsed.success ? parsed.data : null;
}

function toIntegration(snap: DocumentSnapshot): Integration | null {
  const d = snap.data();
  if (!d) return null;
  const parsed = integrationSchema.safeParse({
    ...d,
    id: snap.id,
    tokenLast4: d.tokenLast4 ?? null,
    updatedBy: d.updatedBy ?? null,
    updatedAt: iso(d.updatedAt),
  });
  return parsed.success ? parsed.data : null;
}

/** agents/{id} (M18): assistants configured by AI Admin / Super Admin. */
export class AgentStore {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.agents);
  }

  async list(): Promise<Agent[]> {
    const snap = await this.col().get();
    return snap.docs
      .map(toAgent)
      .filter((a): a is Agent => a !== null)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Agent | null> {
    if (!/^[A-Za-z0-9]{1,64}$/.test(id)) return null;
    return toAgent(await this.col().doc(id).get());
  }

  async create(input: UpsertAgentRequest, by: string): Promise<Agent> {
    const ref = this.col().doc();
    await ref.create({
      ...input,
      createdBy: by,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return (await this.get(ref.id))!;
  }

  /** Null when the agent does not exist. */
  async update(id: string, input: UpsertAgentRequest, by: string): Promise<Agent | null> {
    const ref = this.col().doc(id);
    if (!(await ref.get()).exists) return null;
    await ref.update({ ...input, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
    return this.get(id);
  }
}

/**
 * integrations/{id} (M18): read-only connectors to LMS/ERP/SIS. The token itself lives in
 * Secret Manager (integration-<id>-token[-staging]); Firestore keeps only its last 4.
 */
export class IntegrationStore {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.integrations);
  }

  async list(): Promise<Integration[]> {
    const snap = await this.col().get();
    return snap.docs
      .map(toIntegration)
      .filter((i): i is Integration => i !== null)
      .sort((a, b) => a.id.localeCompare(b.id));
  }

  async get(id: string): Promise<Integration | null> {
    if (!/^[a-z][a-z0-9-]{1,29}$/.test(id)) return null;
    return toIntegration(await this.col().doc(id).get());
  }

  /** Creates or replaces the configuration (the token is kept). */
  async put(id: string, input: UpsertIntegrationRequest, by: string): Promise<Integration> {
    await this.col()
      .doc(id)
      .set({ ...input, updatedBy: by, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    return (await this.get(id))!;
  }

  async setTokenLast4(id: string, last4: string, by: string): Promise<void> {
    await this.col()
      .doc(id)
      .update({ tokenLast4: last4, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
  }
}
