import type { INestApplication } from '@nestjs/common';
import { ROLES, TERMS_VERSION, type Role } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

beforeAll(async () => {
  ({ app, identity } = await startApp());
});
afterAll(async () => {
  await app?.close();
});
beforeEach(async () => {
  await resetData();
  identity.revoked = [];
});

describe('authentication', () => {
  it('401 without a token, with a malformed header or an invalid token', async () => {
    expect((await http().get('/api/me')).status).toBe(401);
    expect((await http().get('/api/me').set('Authorization', 'Basic x')).status).toBe(401);
    expect((await http().get('/api/me').set('Authorization', 'Bearer broken')).status).toBe(401);
  });

  it('403 for other domains and unverified emails, and records AUTH_DENIED', async () => {
    const gmail = await http().get('/api/me').set('Authorization', tokenFor('g1', 'x@gmail.com'));
    expect(gmail.status).toBe(403);
    expect(gmail.body.message).toContain('@ftu.edu.vn');
    const unverified = await http()
      .get('/api/me')
      .set('Authorization', tokenFor('u0', 'u0@ftu.edu.vn', false));
    expect(unverified.status).toBe(403);
    // Denials are audited without blocking the response, so wait for the writes to land.
    await vi.waitFor(
      async () =>
        expect((await audit().list()).filter((l) => l.event === 'AUTH_DENIED')).toHaveLength(2),
      { timeout: 5000, interval: 100 },
    );
    expect(await users().get('g1')).toBeNull();
  });

  it('lets only the listed, verified break-glass address in from outside the domain', async () => {
    const ok = await http()
      .get('/api/me')
      .set('Authorization', tokenFor('bg', 'BreakGlass@gmail.com'));
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ email: 'breakglass@gmail.com', status: 'pending' });
    const unverified = await http()
      .get('/api/me')
      .set('Authorization', tokenFor('bg2', 'breakglass@gmail.com', false));
    expect(unverified.status).toBe(403);
    const other = await http()
      .get('/api/me')
      .set('Authorization', tokenFor('bg3', 'breakglass2@gmail.com'));
    expect(other.status).toBe(403);
  });

  it('health stays public', async () => {
    expect((await http().get('/health')).status).toBe(200);
  });

  it('denies an endpoint that forgot to declare @Roles', async () => {
    await givenUser(app, 'sa', 'super_admin');
    const res = await http().get('/api/test/unguarded').set('Authorization', tokenFor('sa'));
    expect(res.status).toBe(403);
  });
});

describe('first sign-in and account status', () => {
  it('provisions an unknown @ftu.edu.vn user as pending; only /api/me is allowed', async () => {
    const me = await http().get('/api/me').set('Authorization', tokenFor('new1'));
    expect(me.status).toBe(200);
    expect(me.body).toMatchObject({ uid: 'new1', role: 'user', status: 'pending' });
    const admin = await http().get('/api/admin/users').set('Authorization', tokenFor('new1'));
    expect(admin.status).toBe(403);
    expect(admin.body.message).toMatch(/chờ quản trị viên duyệt/);
  });

  it('activates a user listed in the directory on first sign-in', async () => {
    await givenUser(app, 'boss', 'super_admin');
    const me = await http().get('/api/me').set('Authorization', tokenFor('boss'));
    expect(me.body).toMatchObject({ role: 'super_admin', status: 'active' });
  });

  it('a locked account is refused on the very next request', async () => {
    await givenUser(app, 'sa', 'super_admin');
    await givenUser(app, 'auditor1', 'auditor');
    expect(
      (await http().get('/api/admin/users').set('Authorization', tokenFor('auditor1'))).status,
    ).toBe(200);

    await http()
      .patch('/api/admin/users/auditor1')
      .set('Authorization', tokenFor('sa'))
      .send({ status: 'locked' })
      .expect(200);

    const after = await http().get('/api/admin/users').set('Authorization', tokenFor('auditor1'));
    expect(after.status).toBe(403);
    expect(after.body.message).toMatch(/đã bị khóa/);
    expect(identity.revoked).toEqual(['auditor1']);
    const me = await http().get('/api/me').set('Authorization', tokenFor('auditor1'));
    expect(me.body.status).toBe('locked');
  });
});

describe('role matrix', () => {
  let seq = 0;
  const cases: { name: string; call: () => request.Test; allowed: Role[]; ok?: number }[] = [
    { name: 'GET /api/me', call: () => http().get('/api/me'), allowed: [...ROLES] },
    {
      name: 'GET /api/admin/users',
      call: () => http().get('/api/admin/users'),
      allowed: ['super_admin', 'auditor', 'unit_admin'],
    },
    {
      name: 'PATCH /api/admin/users/:uid',
      call: () => http().patch('/api/admin/users/target').send({ departmentId: 'QLDT' }),
      allowed: ['super_admin'],
    },
    {
      name: 'GET /api/admin/audit-logs',
      call: () => http().get('/api/admin/audit-logs'),
      allowed: ['super_admin', 'auditor'],
    },
    {
      name: 'GET /api/admin/departments',
      call: () => http().get('/api/admin/departments'),
      allowed: ['super_admin', 'auditor', 'unit_admin', 'ai_admin'],
    },
    {
      name: 'GET /api/admin/departments/export.csv',
      call: () => http().get('/api/admin/departments/export.csv'),
      allowed: ['super_admin', 'auditor'],
    },
    {
      name: 'PATCH /api/admin/departments/:id',
      call: () =>
        http().patch('/api/admin/departments/QLDT').send({ name: 'Phòng Quản lý đào tạo' }),
      allowed: ['super_admin'],
    },
    {
      name: 'POST /api/admin/departments/import (dry run)',
      call: () =>
        http().post('/api/admin/departments/import').send({
          csv: 'ma_don_vi,ten_don_vi,loai,ma_don_vi_cha\nQLDT,Phòng QLĐT,phong,FTU',
          dryRun: true,
        }),
      allowed: ['super_admin'],
    },
    {
      name: 'GET /api/admin/directory',
      call: () => http().get('/api/admin/directory'),
      allowed: ['super_admin', 'auditor', 'unit_admin'],
    },
    {
      name: 'GET /api/admin/directory/export.csv',
      call: () => http().get('/api/admin/directory/export.csv'),
      allowed: ['super_admin', 'auditor', 'unit_admin'],
    },
    {
      name: 'GET /api/admin/providers',
      call: () => http().get('/api/admin/providers'),
      allowed: ['super_admin', 'ai_admin', 'auditor'],
    },
    {
      name: 'PATCH /api/admin/providers/:id',
      call: () => http().patch('/api/admin/providers/gemini').send({ fallbackOrder: 2 }),
      allowed: ['super_admin', 'ai_admin'],
    },
    {
      name: 'PUT /api/admin/providers/:id/key',
      call: () =>
        http()
          .put('/api/admin/providers/openai/key')
          .send({ apiKey: 'sk-matrix-0123456789abcdef' }),
      allowed: ['super_admin'],
    },
    {
      name: 'GET /api/admin/models',
      call: () => http().get('/api/admin/models'),
      allowed: ['super_admin', 'ai_admin', 'auditor'],
    },
    {
      name: 'POST /api/admin/models',
      call: () =>
        http()
          .post('/api/admin/models')
          .send({
            id: `matrix-${++seq}`,
            providerId: 'mock',
            apiModelId: 'mock-economy',
            displayName: 'Matrix',
            tier: 'economy',
            contextWindow: 1000,
            maxOutputTokens: 100,
            capabilities: ['text'],
            price: { inputPerMTok: 1, outputPerMTok: 1 },
          }),
      allowed: ['super_admin', 'ai_admin'],
      ok: 201,
    },
    {
      name: 'POST /api/admin/models/seed',
      call: () => http().post('/api/admin/models/seed'),
      allowed: ['super_admin', 'ai_admin'],
    },
    {
      name: 'PATCH /api/admin/models/:id',
      call: () => http().patch('/api/admin/models/mock-economy').send({ priority: 1 }),
      allowed: ['super_admin', 'ai_admin'],
    },
    {
      name: 'GET /api/admin/models/:id/prices',
      call: () => http().get('/api/admin/models/mock-economy/prices'),
      allowed: ['super_admin', 'ai_admin', 'auditor'],
    },
    {
      name: 'POST /api/admin/models/:id/prices',
      call: () =>
        http()
          .post('/api/admin/models/mock-economy/prices')
          .send({ inputPerMTok: 1, outputPerMTok: 1 }),
      allowed: ['super_admin', 'ai_admin'],
      ok: 201,
    },
    {
      name: 'GET /api/ai/models',
      call: () => http().get('/api/ai/models'),
      allowed: [...ROLES],
    },
    {
      name: 'POST /api/ai/chat',
      call: () => http().post('/api/ai/chat').send({ message: 'Xin chào' }),
      allowed: [...ROLES],
    },
    {
      name: 'GET /api/conversations',
      call: () => http().get('/api/conversations'),
      allowed: [...ROLES],
    },
    {
      name: 'POST /api/conversations',
      call: () => http().post('/api/conversations').send({}),
      allowed: [...ROLES],
      ok: 201,
    },
    {
      name: 'GET /api/me/quota',
      call: () => http().get('/api/me/quota'),
      allowed: [...ROLES],
    },
    {
      name: 'GET /api/admin/quotas',
      call: () => http().get('/api/admin/quotas'),
      allowed: ['super_admin', 'unit_admin', 'auditor'],
    },
    {
      name: 'POST /api/admin/quota-adjustments',
      call: () =>
        http().post('/api/admin/quota-adjustments').send({
          uid: 'target',
          type: 'decrease',
          amount: 1,
          reason: 'Ma trận vai trò',
          approvedBy: 'Kiểm thử',
        }),
      allowed: ['super_admin', 'unit_admin'],
      ok: 201,
    },
    {
      name: 'GET /api/admin/quota-adjustments',
      call: () => http().get('/api/admin/quota-adjustments'),
      allowed: ['super_admin', 'unit_admin', 'auditor'],
    },
    {
      name: 'GET /api/admin/quota-tiers',
      call: () => http().get('/api/admin/quota-tiers'),
      allowed: ['super_admin', 'unit_admin', 'auditor', 'ai_admin'],
    },
    {
      name: 'PATCH /api/admin/quota-tiers/:id',
      call: () => http().patch('/api/admin/quota-tiers/power').send({ requestsPerMinute: 20 }),
      allowed: ['super_admin'],
    },
    {
      name: 'GET /api/admin/budgets',
      call: () => http().get('/api/admin/budgets'),
      allowed: ['super_admin', 'unit_admin', 'auditor'],
    },
    {
      name: 'PUT /api/admin/budgets/:departmentId',
      call: () =>
        http()
          .put('/api/admin/budgets/QLDT')
          .send({ budget: 900_000_000, reason: 'Ma trận vai trò' }),
      allowed: ['super_admin', 'unit_admin'],
    },
    {
      name: 'GET /api/me/usage',
      call: () => http().get('/api/me/usage'),
      allowed: [...ROLES],
    },
    {
      name: 'GET /api/me/notifications',
      call: () => http().get('/api/me/notifications'),
      allowed: [...ROLES],
    },
    {
      name: 'POST /api/me/notifications/read',
      call: () => http().post('/api/me/notifications/read').send({}),
      allowed: [...ROLES],
      ok: 204,
    },
    {
      name: 'GET /api/admin/dashboard',
      call: () => http().get('/api/admin/dashboard'),
      allowed: ['super_admin', 'ai_admin', 'auditor', 'unit_admin'],
    },
    {
      name: 'GET /api/admin/usage/export.csv',
      call: () => http().get('/api/admin/usage/export.csv?kind=users'),
      allowed: ['super_admin', 'auditor', 'unit_admin'],
    },
    {
      name: 'GET /api/admin/settings/exchange-rate',
      call: () => http().get('/api/admin/settings/exchange-rate'),
      allowed: ['super_admin', 'ai_admin', 'auditor', 'unit_admin'],
    },
    {
      name: 'PUT /api/admin/settings/exchange-rate',
      call: () => http().put('/api/admin/settings/exchange-rate').send({ vndPerUsd: 25_500 }),
      allowed: ['super_admin'],
    },
    {
      name: 'POST /api/files',
      call: () =>
        http().post('/api/files').send({ name: 'a.pdf', mime: 'application/pdf', size: 10 }),
      allowed: [...ROLES],
      ok: 201,
    },
    // Owner-only file routes: an unknown id is 404 for every role, never 403.
    {
      name: 'GET /api/files/:id',
      call: () => http().get('/api/files/missing'),
      allowed: [...ROLES],
      ok: 404,
    },
    {
      name: 'PUT /api/files/:id/content',
      call: () =>
        http()
          .put('/api/files/missing/content')
          .set('Content-Type', 'application/pdf')
          .send(Buffer.from('%PDF-')),
      allowed: [...ROLES],
      ok: 404,
    },
    {
      name: 'POST /api/files/:id/complete',
      call: () => http().post('/api/files/missing/complete'),
      allowed: [...ROLES],
      ok: 404,
    },
    {
      name: 'DELETE /api/files/:id',
      call: () => http().delete('/api/files/missing'),
      allowed: [...ROLES],
      ok: 404,
    },
    {
      name: 'GET /api/admin/kill-switch',
      call: () => http().get('/api/admin/kill-switch'),
      allowed: ['super_admin', 'ai_admin', 'auditor'],
    },
    {
      name: 'PUT /api/admin/kill-switch',
      call: () =>
        http().put('/api/admin/kill-switch').send({
          all: false,
          providers: [],
          models: [],
          tiers: [],
          reason: '',
          autoBrakePercent: 100,
        }),
      allowed: ['super_admin', 'ai_admin'],
    },
    {
      name: 'POST /api/me/terms',
      call: () => http().post('/api/me/terms').send({ version: TERMS_VERSION }),
      allowed: [...ROLES],
      ok: 204,
    },
    {
      name: 'POST /api/admin/models/:id/test',
      call: () => http().post('/api/admin/models/mock-economy/test').send({ prompt: 'Chào' }),
      allowed: ['super_admin', 'ai_admin'],
    },
  ];

  for (const c of cases) {
    it(`${c.name}: allowed ${c.allowed.join(', ')}`, async () => {
      await givenUser(app, 'target', 'user', 'active', { departmentId: 'QLDT' });
      for (const role of ROLES) {
        // Unit admins manage the whole tree here, so scope checks never mask the role check.
        await givenUser(
          app,
          `r-${role}`,
          role,
          'active',
          role === 'unit_admin' ? { departmentId: 'FTU', scopeDepartmentId: 'FTU' } : {},
        );
        const res = await c.call().set('Authorization', tokenFor(`r-${role}`));
        const expected = c.allowed.includes(role) ? (c.ok ?? 200) : 403;
        expect(res.status, `${role} → ${c.name}`).toBe(expected);
      }
    });
  }
});

describe('admin user management', () => {
  beforeEach(async () => {
    await givenUser(app, 'sa', 'super_admin');
  });

  it('unit admins only see users of their own department', async () => {
    await givenUser(app, 'ka', 'unit_admin', 'active', {
      departmentId: 'KTQT',
      scopeDepartmentId: 'KTQT',
    });
    await givenUser(app, 'gv-kt', 'user', 'active', { departmentId: 'KTQT-KTVM' });
    await givenUser(app, 'gv-cntt', 'user', 'active', { departmentId: 'QTKD' });
    await givenUser(app, 'noscope', 'unit_admin');

    const res = await http().get('/api/admin/users').set('Authorization', tokenFor('ka'));
    expect(res.body.users.map((u: { uid: string }) => u.uid).sort()).toEqual(['gv-kt', 'ka']);
    const none = await http().get('/api/admin/users').set('Authorization', tokenFor('noscope'));
    expect(none.body.users).toEqual([]);
  });

  it('filters by status and rejects an unknown status', async () => {
    await http().get('/api/me').set('Authorization', tokenFor('waiting'));
    const pending = await http()
      .get('/api/admin/users?status=pending')
      .set('Authorization', tokenFor('sa'));
    expect(pending.body.users.map((u: { uid: string }) => u.uid)).toEqual(['waiting']);
    expect(
      (await http().get('/api/admin/users?status=xyz').set('Authorization', tokenFor('sa'))).status,
    ).toBe(400);
  });

  it('approves a pending user, records ADMIN_CHANGE and mirrors the directory', async () => {
    await http().get('/api/me').set('Authorization', tokenFor('waiting'));
    const res = await http()
      .patch('/api/admin/users/waiting')
      .set('Authorization', tokenFor('sa'))
      .send({ status: 'active', role: 'ai_admin' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'active', role: 'ai_admin' });
    const change = (await audit().list()).find((l) => l.event === 'ADMIN_CHANGE');
    expect(change).toMatchObject({ actor: 'sa', target: 'waiting' });
    expect(change?.metadata).toMatchObject({ before: { status: 'pending', role: 'user' } });
    expect(identity.revoked).toEqual([]);
  });

  it('validates the body, refuses self-demotion and unknown users', async () => {
    const patch = (uid: string, body: unknown) =>
      http()
        .patch(`/api/admin/users/${uid}`)
        .set('Authorization', tokenFor('sa'))
        .send(body as object);
    expect((await patch('sa', { role: 'user' })).status).toBe(400);
    expect((await patch('sa', { status: 'locked' })).status).toBe(400);
    expect((await patch('nobody', { status: 'active' })).status).toBe(404);
    expect((await patch('users%2Fsa', { status: 'active' })).status).toBe(404);
    expect((await patch('sa', {})).status).toBe(400);
    expect((await patch('sa', { role: 'god' })).status).toBe(400);
    expect((await patch('sa', { email: 'x@ftu.edu.vn' })).status).toBe(400);
  });

  it('lists audit logs for super admins', async () => {
    const res = await http()
      .get('/api/admin/audit-logs?limit=5')
      .set('Authorization', tokenFor('sa'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.logs)).toBe(true);
  });
});
