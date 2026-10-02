import { beforeEach, describe, expect, it } from 'vitest';
import { getDb } from './admin.js';
import { FileStore, GcsBlobStore, toFileView } from './files.js';
import { clearFirestoreEmulator } from './testing.js';

const db = getDb();
const store = new FileStore(db, 'staging');

beforeEach(async () => {
  await clearFirestoreEmulator();
});

describe('FileStore', () => {
  it('creates pending uploads under tmp/, owner-only, expiring after a day', async () => {
    const f = await store.create({
      ownerUid: 'u1',
      name: 'Quy chế.pdf',
      mime: 'application/pdf',
      kind: 'pdf',
      size: 1234,
    });
    expect(f).toMatchObject({ status: 'pending', ownerUid: 'u1', storagePath: null });
    expect(f.uploadPath).toBe(`tmp/staging/u1/${f.id}`);
    expect(store.keptPath(f)).toBe(`files/staging/u1/${f.id}.txt`);
    expect(store.keptPath({ ...f, kind: 'image' })).toBe(`files/staging/u1/${f.id}`);
    const expireAt = (await db.collection('files').doc(f.id).get()).get('expireAt').toMillis();
    expect(Math.round((expireAt - Date.now()) / 3600_000)).toBe(24);

    expect(await store.get(f.id, 'u2')).toBeNull();
    expect(await store.getMany([f.id, 'missing'], 'u2')).toEqual([]);
    expect((await store.getMany(['missing', f.id], 'u1')).map((r) => r.id)).toEqual([f.id]);

    await store.markReady(
      f.id,
      { storagePath: store.keptPath(f), pages: 3, chars: 900, truncated: false },
      180,
    );
    const ready = await store.get(f.id, 'u1');
    expect(toFileView(ready!)).toMatchObject({ status: 'ready', pages: 3, chars: 900 });
    expect(toFileView(ready!)).not.toHaveProperty('ownerUid');
    const kept = (await db.collection('files').doc(f.id).get()).get('expireAt').toMillis();
    expect(Math.round((kept - Date.now()) / 86_400_000)).toBe(180);

    await store.markFailed(f.id, 'Tệp hỏng');
    expect((await store.get(f.id, 'u1'))?.error).toBe('Tệp hỏng');
  });
});

describe('GcsBlobStore (Storage emulator)', () => {
  it('writes, measures, reads and deletes objects', async () => {
    const blobs = new GcsBlobStore('demo-uniai.appspot.com');
    const path = `tmp/test/${Date.now()}`;
    expect(await blobs.size(path)).toBeNull();
    await blobs.write(path, 'xin chào', 'text/plain');
    expect(await blobs.size(path)).toBe(Buffer.byteLength('xin chào'));
    expect((await blobs.read(path)).toString('utf8')).toBe('xin chào');
    await blobs.delete(path);
    await blobs.delete(path);
    expect(await blobs.size(path)).toBeNull();
  });
});
