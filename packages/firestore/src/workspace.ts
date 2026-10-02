import {
  FieldValue,
  Timestamp,
  type DocumentSnapshot,
  type Firestore,
} from 'firebase-admin/firestore';
import {
  extractVariables,
  type CreateProjectRequest,
  type CreatePromptRequest,
  type Project,
  type Prompt,
  type UpdateProjectRequest,
  type UpdatePromptRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

const iso = (t: unknown) =>
  t instanceof Timestamp ? t.toDate().toISOString() : new Date(0).toISOString();

/** prompts/{id} as stored. */
export interface PromptRecord extends Omit<Prompt, 'editable'> {
  createdByRole: string;
}

function toPrompt(snap: DocumentSnapshot): PromptRecord {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    title: d.title ?? '',
    description: d.description ?? '',
    body: d.body ?? '',
    category: d.category ?? 'khac',
    variables: Array.isArray(d.variables) ? d.variables : [],
    visibility: d.visibility ?? 'private',
    publishedTo: Array.isArray(d.publishedTo) ? d.publishedTo : [],
    ownerUid: d.ownerUid,
    createdByRole: d.createdByRole ?? 'user',
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

/** Prompt library (spec 8.10): private prompts and prompts published to units. */
export class PromptStore {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.prompts);
  }

  /** The caller's own prompts plus shared prompts published to the whole school or to a unit on `departmentPath`. */
  async visible(uid: string, departmentPath: string[], all = false): Promise<PromptRecord[]> {
    const [mine, shared] = await Promise.all([
      this.col().where('ownerUid', '==', uid).get(),
      this.col().where('visibility', '==', 'shared').get(),
    ]);
    const byId = new Map<string, PromptRecord>();
    for (const d of mine.docs) byId.set(d.id, toPrompt(d));
    for (const d of shared.docs) {
      const p = toPrompt(d);
      if (
        all ||
        p.publishedTo.length === 0 ||
        p.publishedTo.some((u) => departmentPath.includes(u))
      ) {
        byId.set(p.id, p);
      }
    }
    return [...byId.values()].sort((a, b) => a.title.localeCompare(b.title, 'vi'));
  }

  async get(id: string): Promise<PromptRecord | null> {
    const snap = await this.col().doc(id).get();
    return snap.exists ? toPrompt(snap) : null;
  }

  async create(input: CreatePromptRequest, ownerUid: string, role: string): Promise<PromptRecord> {
    const ref = this.col().doc();
    const now = FieldValue.serverTimestamp();
    await ref.create({
      ...input,
      publishedTo: input.visibility === 'shared' ? input.publishedTo : [],
      variables: extractVariables(input.body),
      ownerUid,
      createdByRole: role,
      createdAt: now,
      updatedAt: now,
    });
    return toPrompt(await ref.get());
  }

  async update(id: string, patch: UpdatePromptRequest): Promise<PromptRecord> {
    const ref = this.col().doc(id);
    const current = toPrompt(await ref.get());
    const visibility = patch.visibility ?? current.visibility;
    await ref.update({
      ...patch,
      ...(patch.body ? { variables: extractVariables(patch.body) } : {}),
      publishedTo: visibility === 'shared' ? (patch.publishedTo ?? current.publishedTo) : [],
      updatedAt: FieldValue.serverTimestamp(),
    });
    return toPrompt(await ref.get());
  }

  async delete(id: string): Promise<void> {
    await this.col().doc(id).delete();
  }
}

function toProject(snap: DocumentSnapshot): Project & { ownerUid: string } {
  const d = snap.data() ?? {};
  return {
    id: snap.id,
    ownerUid: d.ownerUid,
    name: d.name ?? '',
    instructions: d.instructions ?? '',
    fileIds: Array.isArray(d.fileIds) ? d.fileIds : [],
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

const view = (p: Project & { ownerUid: string }): Project => ({
  id: p.id,
  name: p.name,
  instructions: p.instructions,
  fileIds: p.fileIds,
  createdAt: p.createdAt,
  updatedAt: p.updatedAt,
});

/** Projects (spec 8.10): a user's own group of conversations, files and instructions. */
export class ProjectStore {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.projects);
  }

  async list(ownerUid: string): Promise<Project[]> {
    const snap = await this.col().where('ownerUid', '==', ownerUid).get();
    return snap.docs
      .map(toProject)
      .map(view)
      .sort((a, b) => a.name.localeCompare(b.name, 'vi'));
  }

  /** The caller's project, or null (also for other people's). */
  async get(id: string, ownerUid: string): Promise<Project | null> {
    const snap = await this.col().doc(id).get();
    if (!snap.exists || snap.get('ownerUid') !== ownerUid) return null;
    return view(toProject(snap));
  }

  async create(input: CreateProjectRequest, ownerUid: string): Promise<Project> {
    const ref = this.col().doc();
    const now = FieldValue.serverTimestamp();
    await ref.create({ ...input, ownerUid, createdAt: now, updatedAt: now });
    return view(toProject(await ref.get()));
  }

  async update(id: string, ownerUid: string, patch: UpdateProjectRequest): Promise<Project | null> {
    if (!(await this.get(id, ownerUid))) return null;
    await this.col()
      .doc(id)
      .update({ ...patch, updatedAt: FieldValue.serverTimestamp() });
    return this.get(id, ownerUid);
  }

  /** Deletes the project; its conversations stay, outside any project. */
  async delete(id: string, ownerUid: string): Promise<boolean> {
    if (!(await this.get(id, ownerUid))) return false;
    const convs = await this.db
      .collection(COLLECTIONS.conversations)
      .where('ownerUid', '==', ownerUid)
      .where('projectId', '==', id)
      .get();
    const batch = this.db.batch();
    convs.docs.forEach((d) => batch.update(d.ref, { projectId: null }));
    batch.delete(this.col().doc(id));
    await batch.commit();
    return true;
  }
}
