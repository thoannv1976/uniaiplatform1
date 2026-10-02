import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorker, type WorkerJobs } from './app.js';
import { loadConfig } from './config.js';

let app: INestApplication;

const calls: string[] = [];
const jobs: WorkerJobs = {
  rollover: () => (calls.push('rollover'), Promise.resolve({ period: '202610', created: 3 })),
  sweepReservations: () => (calls.push('sweep'), Promise.resolve(2)),
  expireAdjustments: () => (calls.push('expire'), Promise.resolve(1)),
  aggregateUsage: () => (
    calls.push('aggregate'),
    Promise.resolve({ period: '202610', added: 5, alerts: 1 })
  ),
};

beforeAll(async () => {
  app = await createWorker(loadConfig({}), { quiet: true, jobs });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('worker', () => {
  it('serves /health', async () => {
    const res = await request(app.getHttpServer()).get('/health').expect(200);
    expect(healthResponseSchema.parse(res.body).service).toBe('uniai-worker');
  });

  it('does not send CORS headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/health')
      .set('Origin', 'https://uniaiplatform1.web.app');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('runs the scheduled jobs', async () => {
    const server = app.getHttpServer();
    expect((await request(server).post('/jobs/quota-rollover').expect(200)).body).toEqual({
      period: '202610',
      created: 3,
    });
    expect((await request(server).post('/jobs/reservation-sweeper').expect(200)).body).toEqual({
      released: 2,
      reverted: 1,
    });
    expect((await request(server).post('/jobs/usage-aggregate').expect(200)).body).toEqual({
      period: '202610',
      added: 5,
      alerts: 1,
    });
    expect(calls).toEqual(['rollover', 'sweep', 'expire', 'aggregate']);
  });
});
