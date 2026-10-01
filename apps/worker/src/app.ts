import 'reflect-metadata';
import { Controller, Get, Inject, Module, type INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { HealthResponse } from '@uniai/shared';
import type { WorkerConfig } from './config.js';

const CONFIG = Symbol('WORKER_CONFIG');

/**
 * Background worker. Receives Cloud Tasks / Cloud Scheduler HTTP calls (authenticated
 * with Google-signed OIDC tokens from M7 on). Not reachable from browsers: no CORS.
 */
@Controller()
class HealthController {
  constructor(@Inject(CONFIG) private readonly config: WorkerConfig) {}

  @Get('health')
  health(): HealthResponse {
    return {
      status: 'ok',
      service: this.config.serviceName,
      version: this.config.version,
      time: new Date().toISOString(),
    };
  }
}

export async function createWorker(
  config: WorkerConfig,
  options: { quiet?: boolean } = {},
): Promise<INestApplication> {
  @Module({ controllers: [HealthController], providers: [{ provide: CONFIG, useValue: config }] })
  class WorkerModule {}

  const app = await NestFactory.create(WorkerModule, {
    logger: options.quiet ? false : ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  return app;
}
