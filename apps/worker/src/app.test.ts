import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorker } from './app.js';
import { loadConfig } from './config.js';

let app: INestApplication;

beforeAll(async () => {
  app = await createWorker(loadConfig({}), { quiet: true });
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('worker', () => {
  it('serves /healthz', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    expect(healthResponseSchema.parse(res.body).service).toBe('uniai-worker');
  });

  it('does not send CORS headers', async () => {
    const res = await request(app.getHttpServer())
      .get('/healthz')
      .set('Origin', 'https://uniaiplatform1.web.app');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
