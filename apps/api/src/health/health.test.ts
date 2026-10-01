import type { INestApplication } from '@nestjs/common';
import { healthResponseSchema } from '@uniai/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../app.factory.js';
import { loadConfig } from '../config.js';

let app: INestApplication;

beforeAll(async () => {
  app = await createApp(
    loadConfig({ WEB_ORIGINS: 'https://uniaiplatform1.web.app', APP_VERSION: 'test' }),
    { quiet: true },
  );
  await app.init();
});

afterAll(async () => {
  await app.close();
});

describe('GET /healthz', () => {
  it('returns a valid health payload', async () => {
    const res = await request(app.getHttpServer()).get('/healthz').expect(200);
    const body = healthResponseSchema.parse(res.body);
    expect(body).toMatchObject({ status: 'ok', service: 'uniai-api', version: 'test' });
  });

  it('allows CORS only for configured web origins', async () => {
    const allowed = await request(app.getHttpServer())
      .get('/healthz')
      .set('Origin', 'https://uniaiplatform1.web.app');
    expect(allowed.headers['access-control-allow-origin']).toBe('https://uniaiplatform1.web.app');

    const denied = await request(app.getHttpServer())
      .get('/healthz')
      .set('Origin', 'https://evil.example.com');
    expect(denied.headers['access-control-allow-origin']).toBeUndefined();
  });
});

describe('loadConfig', () => {
  it('rejects an invalid PORT', () => {
    expect(() => loadConfig({ PORT: 'abc' })).toThrow('PORT');
  });

  it('defaults to port 8080 like Cloud Run', () => {
    expect(loadConfig({}).port).toBe(8080);
  });
});
