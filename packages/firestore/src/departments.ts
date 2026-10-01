import { FieldValue, type DocumentReference, type Firestore } from 'firebase-admin/firestore';
import type {
  CreateDepartmentRequest,
  Department,
  DepartmentImportRow,
  ImportIssue,
  ImportResult,
  UpdateDepartmentRequest,
} from '@uniai/shared';
import { COLLECTIONS } from './collections.js';

export class DepartmentError extends Error {
  constructor(
    message: string,
    readonly code: 'not_found' | 'conflict' | 'invalid',
  ) {
    super(message);
  }
}

type StoredDepartment = Omit<Department, 'id'>;
const WRITE_BATCH = 400;

/** Resolves ancestor paths for a set of departments; reports missing parents and cycles. */
export function resolvePaths(departments: Map<string, { parentId: string | null }>): {
  paths: Map<string, string[]>;
  errors: Map<string, string>;
} {
  const paths = new Map<string, string[]>();
  const errors = new Map<string, string>();
  const visit = (id: string, stack: string[]): string[] | null => {
    const known = paths.get(id);
    if (known) return known;
    if (stack.includes(id)) {
      errors.set(id, `Vòng lặp đơn vị cha: ${[...stack, id].join(' → ')}`);
      return null;
    }
    const dept = departments.get(id);
    if (!dept) return null;
    if (dept.parentId === null) {
      paths.set(id, [id]);
      return [id];
    }
    if (!departments.has(dept.parentId)) {
      errors.set(id, `Không có đơn vị cha ${dept.parentId}`);
      return null;
    }
    const parentPath = visit(dept.parentId, [...stack, id]);
    if (!parentPath) {
      if (!errors.has(id)) errors.set(id, `Đơn vị cha ${dept.parentId} không hợp lệ`);
      return null;
    }
    const path = [...parentPath, id];
    paths.set(id, path);
    return path;
  };
  for (const id of departments.keys()) visit(id, []);
  return { paths, errors };
}

export class DepartmentStore {
  constructor(private readonly db: Firestore) {}

  private col() {
    return this.db.collection(COLLECTIONS.departments);
  }

  async list(): Promise<Department[]> {
    const snap = await this.col().get();
    return snap.docs
      .map((d) => ({ id: d.id, ...(d.data() as StoredDepartment) }))
      .sort((a, b) => a.path.join('/').localeCompare(b.path.join('/')));
  }

  async get(id: string): Promise<Department | null> {
    const snap = await this.col().doc(id).get();
    return snap.exists ? { id, ...(snap.data() as StoredDepartment) } : null;
  }

  async create(input: CreateDepartmentRequest, by: string): Promise<Department> {
    const ref = this.col().doc(input.id);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(ref)).exists)
        throw new DepartmentError(`Mã đơn vị ${input.id} đã tồn tại.`, 'conflict');
      let path: string[];
      if (input.parentId === null) {
        if (input.type !== 'university') {
          throw new DepartmentError('Chỉ đơn vị loại "Trường" mới không có đơn vị cha.', 'invalid');
        }
        const roots = await tx.get(this.col().where('parentId', '==', null).limit(1));
        if (!roots.empty) throw new DepartmentError('Đã có đơn vị gốc (Trường).', 'conflict');
        path = [input.id];
      } else {
        const parent = await tx.get(this.col().doc(input.parentId));
        if (!parent.exists)
          throw new DepartmentError(`Không có đơn vị cha ${input.parentId}.`, 'invalid');
        if (parent.get('status') !== 'active') {
          throw new DepartmentError(`Đơn vị cha ${input.parentId} đã ngừng sử dụng.`, 'invalid');
        }
        path = [...(parent.get('path') as string[]), input.id];
      }
      const doc: StoredDepartment = {
        name: input.name,
        type: input.type,
        parentId: input.parentId,
        path,
        status: 'active',
      };
      tx.create(ref, { ...doc, updatedBy: by, updatedAt: FieldValue.serverTimestamp() });
      return { id: input.id, ...doc };
    });
  }

  async update(
    id: string,
    patch: UpdateDepartmentRequest,
    by: string,
  ): Promise<{ before: Department; after: Department }> {
    const all = new Map((await this.list()).map((d) => [d.id, d]));
    const before = all.get(id);
    if (!before) throw new DepartmentError('Không tìm thấy đơn vị.', 'not_found');

    if (patch.parentId !== undefined && patch.parentId !== before.parentId) {
      if (patch.parentId === null)
        throw new DepartmentError('Không thể biến đơn vị thành đơn vị gốc.', 'invalid');
      const parent = all.get(patch.parentId);
      if (!parent) throw new DepartmentError(`Không có đơn vị cha ${patch.parentId}.`, 'invalid');
      if (parent.path.includes(id)) {
        throw new DepartmentError(
          'Không thể chuyển đơn vị vào chính nó hoặc đơn vị con của nó.',
          'invalid',
        );
      }
    }
    if (patch.status === 'archived' && before.status !== 'archived') {
      const activeChild = [...all.values()].find((d) => d.parentId === id && d.status === 'active');
      if (activeChild)
        throw new DepartmentError(
          `Đơn vị còn đơn vị con đang hoạt động (${activeChild.id}).`,
          'conflict',
        );
      const members = await this.db
        .collection(COLLECTIONS.userDirectory)
        .where('departmentId', '==', id)
        .limit(1)
        .get();
      if (!members.empty)
        throw new DepartmentError(
          'Đơn vị còn cán bộ; hãy chuyển cán bộ sang đơn vị khác trước.',
          'conflict',
        );
    }
    if (before.parentId === null && patch.type && patch.type !== 'university') {
      throw new DepartmentError('Đơn vị gốc phải có loại "Trường".', 'invalid');
    }

    const after: Department = { ...before, ...patch };
    all.set(id, after);
    const { paths } = resolvePaths(all);
    const changed = new Map<string, string[]>();
    for (const [deptId, path] of paths) {
      const old = all.get(deptId);
      if (old && old.path.join('/') !== path.join('/')) changed.set(deptId, path);
    }
    after.path = paths.get(id) ?? before.path;

    await this.col()
      .doc(id)
      .update({
        ...patch,
        path: after.path,
        updatedBy: by,
        updatedAt: FieldValue.serverTimestamp(),
      });
    await this.applyPathChanges(changed, id);
    return { before, after };
  }

  /**
   * Validates and (unless dryRun) applies a department CSV. All-or-nothing: if any row has
   * an issue nothing is written.
   */
  async importRows(
    rows: DepartmentImportRow[],
    issues: ImportIssue[],
    options: { dryRun: boolean; by: string; total: number },
  ): Promise<ImportResult> {
    const existing = new Map((await this.list()).map((d) => [d.id, d]));
    const merged = new Map<string, { parentId: string | null }>(existing);
    for (const r of rows) merged.set(r.id, { parentId: r.parentId });

    const lineOf = new Map(rows.map((r) => [r.id, r.line]));
    const { paths, errors } = resolvePaths(merged);
    for (const [id, message] of errors) {
      const line = lineOf.get(id);
      if (line) issues.push({ line, column: 'ma_don_vi_cha', message });
    }
    const roots = [...merged.entries()].filter(([, d]) => d.parentId === null).map(([id]) => id);
    if (roots.length > 1) {
      for (const id of roots) {
        const line = lineOf.get(id);
        if (line)
          issues.push({
            line,
            column: 'ma_don_vi_cha',
            message: `Chỉ được có một đơn vị gốc (đang có: ${roots.join(', ')})`,
          });
      }
    }
    for (const r of rows) {
      if (r.parentId === null && r.type !== 'university') {
        issues.push({
          line: r.line,
          column: 'loai',
          message: 'Đơn vị không có đơn vị cha phải có loại "truong"',
        });
      }
    }

    let created = 0;
    let updated = 0;
    const writes: { id: string; data: StoredDepartment }[] = [];
    for (const r of rows) {
      const path = paths.get(r.id) ?? [];
      const old = existing.get(r.id);
      const data: StoredDepartment = {
        name: r.name,
        type: r.type,
        parentId: r.parentId,
        path,
        status: old?.status ?? 'active',
      };
      if (!old) created++;
      else if (old.name !== r.name || old.type !== r.type || old.parentId !== r.parentId) updated++;
      else continue;
      writes.push({ id: r.id, data });
    }
    const result: ImportResult = {
      dryRun: options.dryRun,
      applied: false,
      total: options.total,
      created,
      updated,
      unchanged: Math.max(
        0,
        options.total - created - updated - new Set(issues.map((i) => i.line)).size,
      ),
      issues: issues.sort((a, b) => a.line - b.line),
    };
    if (options.dryRun || issues.length) return result;

    const changedPaths = new Map<string, string[]>();
    for (const [id, path] of paths) {
      const old = existing.get(id);
      if (old && old.path.join('/') !== path.join('/')) changedPaths.set(id, path);
    }
    for (let i = 0; i < writes.length; i += WRITE_BATCH) {
      const batch = this.db.batch();
      for (const w of writes.slice(i, i + WRITE_BATCH)) {
        batch.set(this.col().doc(w.id), {
          ...w.data,
          updatedBy: options.by,
          updatedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
    await this.applyPathChanges(changedPaths);
    return { ...result, applied: true };
  }

  /** Rewrites department paths and the departmentPath of members after a move. */
  private async applyPathChanges(changed: Map<string, string[]>, skipDepartmentId?: string) {
    if (changed.size === 0) return;
    const ops: { ref: DocumentReference; data: Record<string, unknown> }[] = [];
    for (const [id, path] of changed) {
      if (id !== skipDepartmentId) ops.push({ ref: this.col().doc(id), data: { path } });
    }
    const ids = [...changed.keys()];
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      for (const collection of [COLLECTIONS.userDirectory, COLLECTIONS.users]) {
        const snap = await this.db.collection(collection).where('departmentId', 'in', chunk).get();
        for (const doc of snap.docs) {
          const path = changed.get(doc.get('departmentId') as string);
          if (path) ops.push({ ref: doc.ref, data: { departmentPath: path } });
        }
      }
    }
    for (let i = 0; i < ops.length; i += WRITE_BATCH) {
      const batch = this.db.batch();
      for (const op of ops.slice(i, i + WRITE_BATCH)) batch.update(op.ref, op.data);
      await batch.commit();
    }
  }

  /** Loads all departments keyed by id (used by the directory import). */
  async map(): Promise<Map<string, Department>> {
    return new Map((await this.list()).map((d) => [d.id, d]));
  }
}
