import 'reflect-metadata';
import {
  Controller,
  Get,
  HttpCode,
  Inject,
  Logger,
  Module,
  Post,
  type INestApplication,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { HealthResponse } from '@uniai/shared';
import type { WorkerConfig } from './config.js';

const CONFIG = Symbol('WORKER_CONFIG');
const JOBS = Symbol('WORKER_JOBS');

/** What the scheduled jobs need; QuotaService implements it (injected for tests). */
export interface WorkerJobs {
  rollover(now?: Date): Promise<{ period: string; created: number }>;
  sweepReservations(now?: Date): Promise<number>;
  expireAdjustments(now?: Date): Promise<number>;
}

/**
 * Background worker. Reached only by Cloud Scheduler / Cloud Tasks with Google-signed OIDC
 * tokens: the Cloud Run service is private (no allUsers invoker), so Cloud Run itself rejects
 * every other caller before the request reaches this code. Not reachable from browsers: no CORS.
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

/** Scheduled jobs (infra/scheduler.sh). Idempotent: safe to run twice. */
@Controller('jobs')
class JobsController {
  private readonly logger = new Logger('Jobs');

  constructor(@Inject(JOBS) private readonly jobs: WorkerJobs) {}

  /** 1st of the month, 00:05 Vietnam time: open everyone's quota period. */
  @Post('quota-rollover')
  @HttpCode(200)
  async rollover() {
    const result = await this.jobs.rollover();
    this.logger.log(JSON.stringify({ job: 'quota-rollover', ...result }));
    return result;
  }

  /** Every 5 minutes: release stale reservations, revert expired temporary grants. */
  @Post('reservation-sweeper')
  @HttpCode(200)
  async sweep() {
    const released = await this.jobs.sweepReservations();
    const reverted = await this.jobs.expireAdjustments();
    this.logger.log(JSON.stringify({ job: 'reservation-sweeper', released, reverted }));
    return { released, reverted };
  }
}

export async function createWorker(
  config: WorkerConfig,
  options: { quiet?: boolean; jobs?: WorkerJobs } = {},
): Promise<INestApplication> {
  @Module({
    controllers: [HealthController, JobsController],
    providers: [
      { provide: CONFIG, useValue: config },
      {
        provide: JOBS,
        // Firestore is only loaded when the worker really runs the jobs.
        useFactory: async (): Promise<WorkerJobs> => {
          if (options.jobs) return options.jobs;
          const { getDb, QuotaService } = await import('@uniai/firestore');
          return new QuotaService(getDb());
        },
      },
    ],
  })
  class WorkerModule {}

  const app = await NestFactory.create(WorkerModule, {
    logger: options.quiet ? false : ['error', 'warn', 'log'],
  });
  app.enableShutdownHooks();
  return app;
}
