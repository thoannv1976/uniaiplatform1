import type { INestApplication } from '@nestjs/common';
import { getDb, runUsageJob } from '@uniai/firestore';
import { monthlyReportViewSchema, previousPeriod, quotaPeriodOf } from '@uniai/shared';
import { strFromU8, unzipSync } from 'fflate';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { audit, givenUser, resetData, startApp, tokenFor } from '../test/harness.js';

let app: INestApplication;
const http = () => request(app.getHttpServer());
const period = quotaPeriodOf(new Date());

async function chat(who: string, message: string) {
  await http()
    .post('/api/ai/chat')
    .set('Authorization', tokenFor(who))
    .send({ message })
    .buffer(true)
    .parse((r, cb) => {
      r.on('data', () => undefined);
      r.on('end', () => cb(null, ''));
    })
    .expect(200);
}

/** Binary body of the Excel export. */
async function download(who: string, query = '') {
  return http()
    .get(`/api/reports/export${query}`)
    .set('Authorization', tokenFor(who))
    .buffer(true)
    .parse((r, cb) => {
      const parts: Buffer[] = [];
      r.on('data', (c: Buffer) => parts.push(c));
      r.on('end', () => cb(null, Buffer.concat(parts)));
    });
}

beforeAll(async () => {
  ({ app } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  await givenUser(app, 'sa', 'super_admin');
  await givenUser(app, 'au', 'auditor');
  await givenUser(app, 'gv-kt', 'user', 'active', { departmentId: 'KTQT-KTVM' });
  await givenUser(app, 'gv-qt', 'user', 'active', { departmentId: 'QTKD' });
  await givenUser(app, 'ka', 'unit_admin', 'active', {
    departmentId: 'KTQT',
    scopeDepartmentId: 'KTQT',
  });
  await chat('gv-kt', 'Xin chào');
  await chat('gv-kt', 'Tóm tắt giúp tôi đoạn này');
  await chat('gv-qt', 'Dịch sang tiếng Anh');
  await runUsageJob(getDb(), new Date(Date.now() + 60_000));
});

describe('monthly reports', () => {
  it('shows the university figures, a unit for Unit Admins, and stores the report', async () => {
    const all = monthlyReportViewSchema.parse(
      (await http().get('/api/reports/monthly').set('Authorization', tokenFor('au')).expect(200))
        .body,
    );
    expect(all).toMatchObject({ period, stored: false, final: false, scopeDepartmentId: null });
    expect(all.requests).toBe(3);
    const ids = all.departments.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['FTU', 'KTQT', 'KTQT-KTVM', 'QTKD']));

    const unit = monthlyReportViewSchema.parse(
      (await http().get('/api/reports/monthly').set('Authorization', tokenFor('ka')).expect(200))
        .body,
    );
    expect(unit).toMatchObject({ scopeDepartmentId: 'KTQT', requests: 2 });
    expect(unit.departments.map((d) => d.id).sort()).toEqual(['KTQT', 'KTQT-KTVM']);
    expect(unit.totalCost).toBe(all.departments.find((d) => d.id === 'KTQT')!.cost);
    expect(unit.byModel.reduce((s, b) => s + b.cost, 0)).toBe(unit.totalCost);

    const stored = await http()
      .post('/api/admin/reports/monthly')
      .set('Authorization', tokenFor('sa'))
      .send({ period })
      .expect(200);
    expect(stored.body).toMatchObject({ stored: true, totalCost: all.totalCost });
    expect(
      (
        await http()
          .get(`/api/reports/monthly?period=${period}`)
          .set('Authorization', tokenFor('ka'))
      ).body.stored,
    ).toBe(true);

    // A month without activity is an empty report, not an error.
    const empty = await http()
      .get(`/api/reports/monthly?period=${previousPeriod(period)}`)
      .set('Authorization', tokenFor('sa'))
      .expect(200);
    expect(empty.body).toMatchObject({ totalCost: 0, requests: 0 });
    expect(
      (await http().get('/api/reports/monthly?period=2026-10').set('Authorization', tokenFor('sa')))
        .status,
    ).toBe(400);
  });

  it('exports Excel, limited to the Unit Admin’s unit, and audits the export', async () => {
    const res = await download('ka', `?period=${period}&format=xlsx`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('spreadsheetml.sheet');
    expect(res.headers['content-disposition']).toContain(`bao-cao-ai-${period}-KTQT.xlsx`);
    const files = unzipSync(new Uint8Array(res.body as Buffer));
    const workbook = strFromU8(files['xl/workbook.xml']!);
    for (const name of [
      'Tổng quan',
      'Đơn vị',
      'Model',
      'Nhà cung cấp',
      'Theo ngày',
      'Người dùng',
    ]) {
      expect(workbook).toContain(`name="${name}"`);
    }
    const everything = Object.entries(files)
      .filter(([path]) => path.startsWith('xl/worksheets/'))
      .map(([, bytes]) => strFromU8(bytes))
      .join('\n');
    expect(everything).toContain('gv-kt@ftu.edu.vn');
    expect(everything).not.toContain('gv-qt@ftu.edu.vn');
    expect(everything).not.toContain('>QTKD<');

    const full = await download('sa');
    const people = strFromU8(
      unzipSync(new Uint8Array(full.body as Buffer))['xl/worksheets/sheet7.xml']!,
    );
    expect(people).toContain('gv-qt@ftu.edu.vn');

    expect((await download('sa', '?format=pdf')).status).toBe(400);
    const exports = (await audit().list()).filter((e) => e.event === 'REPORT_EXPORT');
    expect(exports.map((e) => e.metadata?.scope).sort()).toEqual(['KTQT', null]);
  });
});
