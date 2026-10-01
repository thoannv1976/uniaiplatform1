import type { INestApplication } from '@nestjs/common';
import { USER_CSV_COLUMNS } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  audit,
  givenUser,
  resetData,
  startApp,
  tokenFor,
  users,
  type RecordingIdentityAdmin,
} from '../test/harness.js';

let app: INestApplication;
let identity: RecordingIdentityAdmin;
const http = () => request(app.getHttpServer());
const header = USER_CSV_COLUMNS.join(',');

beforeAll(async () => {
  ({ app, identity } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  identity.revoked = [];
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'ka', 'unit_admin', 'active', {
    departmentId: 'KTQT',
    scopeDepartmentId: 'KTQT',
  });
});

const importCsv = (who: string, csv: string, dryRun: boolean) =>
  http()
    .post('/api/admin/directory/import')
    .set('Authorization', tokenFor(who))
    .send({ csv, dryRun });

describe('departments API', () => {
  it('creates, moves and exports departments; maps domain errors to HTTP codes', async () => {
    const sa = tokenFor('sa');
    const created = await http()
      .post('/api/admin/departments')
      .set('Authorization', sa)
      .send({
        id: 'ktqt-tmqt',
        name: 'Bộ môn Thương mại quốc tế',
        type: 'division',
        parentId: 'KTQT',
      })
      .expect(201);
    expect(created.body).toMatchObject({ id: 'KTQT-TMQT', path: ['FTU', 'KTQT', 'KTQT-TMQT'] });

    const dup = await http()
      .post('/api/admin/departments')
      .set('Authorization', sa)
      .send({ id: 'KTQT', name: 'x', type: 'faculty', parentId: 'FTU' });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/đã tồn tại/);

    const cycle = await http()
      .patch('/api/admin/departments/KTQT')
      .set('Authorization', sa)
      .send({ parentId: 'KTQT-TMQT' });
    expect(cycle.status).toBe(400);
    expect(
      (
        await http()
          .patch('/api/admin/departments/KHONG')
          .set('Authorization', sa)
          .send({ name: 'x' })
      ).status,
    ).toBe(404);

    const csv = await http()
      .get('/api/admin/departments/export.csv')
      .set('Authorization', sa)
      .expect(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain('KTQT-TMQT,Bộ môn Thương mại quốc tế,bo_mon,KTQT');
  });

  it('rejects malformed CSV with a Vietnamese 400', async () => {
    const res = await http()
      .post('/api/admin/departments/import')
      .set('Authorization', tokenFor('sa'))
      .send({ csv: 'a,a\n1,2', dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/lặp lại/);
  });
});

describe('directory API', () => {
  it('previews then applies an import and records the audit entry', async () => {
    const csv = `${header}\ngv1@ftu.edu.vn,Nguyễn Văn A,CB1,KTQT-KTVM,Giảng viên,,,,\ngv2@ftu.edu.vn,Trần B,,QLDT,,,,,`;
    const preview = await importCsv('sa', csv, true).expect(200);
    expect(preview.body).toMatchObject({ dryRun: true, applied: false, created: 2 });
    expect(await users().getEntry('gv1@ftu.edu.vn')).toBeNull();

    const applied = await importCsv('sa', csv, false).expect(200);
    expect(applied.body).toMatchObject({ applied: true, created: 2 });
    const change = (await audit().list()).find((l) => l.metadata.action === 'import_directory');
    expect(change).toMatchObject({ actor: 'sa', metadata: { created: 2 } });
  });

  it('unit admins see and export only their subtree', async () => {
    await importCsv(
      'sa',
      `${header}\nin@ftu.edu.vn,,,KTQT-KTVM,,,,,\nout@ftu.edu.vn,,,QTKD,,,,,`,
      false,
    ).expect(200);
    const list = await http()
      .get('/api/admin/directory')
      .set('Authorization', tokenFor('ka'))
      .expect(200);
    expect(list.body.entries.map((e: { email: string }) => e.email)).toEqual([
      'in@ftu.edu.vn',
      'ka@ftu.edu.vn',
    ]);
    const csv = await http()
      .get('/api/admin/directory/export.csv')
      .set('Authorization', tokenFor('ka'))
      .expect(200);
    expect(csv.text).toContain('in@ftu.edu.vn');
    expect(csv.text).not.toContain('out@ftu.edu.vn');
  });

  it('unit admins can lock staff in their unit (revoking sessions) but not outside it or change roles', async () => {
    await importCsv(
      'sa',
      `${header}\nin@ftu.edu.vn,,,KTQT-KTVM,,,,,\nout@ftu.edu.vn,,,QTKD,,,,,`,
      false,
    ).expect(200);
    await http().get('/api/me').set('Authorization', tokenFor('in'));
    const ka = tokenFor('ka');

    const locked = await http()
      .patch('/api/admin/directory/in@ftu.edu.vn')
      .set('Authorization', ka)
      .send({ status: 'locked' });
    expect(locked.status).toBe(200);
    expect(identity.revoked).toEqual(['in']);
    expect(
      (await http().get('/api/admin/directory').set('Authorization', tokenFor('in'))).status,
    ).toBe(403);

    expect(
      (
        await http()
          .patch('/api/admin/directory/out@ftu.edu.vn')
          .set('Authorization', ka)
          .send({ title: 'x' })
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .patch('/api/admin/directory/in@ftu.edu.vn')
          .set('Authorization', ka)
          .send({ role: 'auditor' })
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .patch('/api/admin/directory/in@ftu.edu.vn')
          .set('Authorization', ka)
          .send({ departmentId: 'QTKD' })
      ).status,
    ).toBe(403);
  });

  it('validates imports by line and refuses unit admin rows outside their scope', async () => {
    const res = await importCsv(
      'ka',
      `${header}\nok@ftu.edu.vn,,,KTQT,,,,,\nx@ftu.edu.vn,,,QTKD,,,,,\ny@gmail.com,,,KTQT,,,,,`,
      false,
    ).expect(200);
    expect(res.body.applied).toBe(false);
    expect(res.body.issues.map((i: { line: number }) => i.line)).toEqual([3, 4]);
  });

  it('rejects bodies that are not a CSV import', async () => {
    expect(
      (
        await http()
          .post('/api/admin/directory/import')
          .set('Authorization', tokenFor('sa'))
          .send({})
      ).status,
    ).toBe(400);
    // Malformed addresses, a decoded "/" and other domains never reach Firestore.
    for (const bad of ['not-an-email', 'a%2Fb@ftu.edu.vn', 'x@gmail.com']) {
      const res = await http()
        .patch(`/api/admin/directory/${bad}`)
        .set('Authorization', tokenFor('sa'))
        .send({ title: 'x' });
      expect(res.status, bad).toBe(404);
    }
  });
});
