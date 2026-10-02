import 'reflect-metadata';
import {
  Body,
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
import { KB_MAX_PAGES, type HealthResponse } from '@uniai/shared';
import type { WorkerConfig } from './config.js';

const CONFIG = Symbol('WORKER_CONFIG');
const JOBS = Symbol('WORKER_JOBS');

/** What the scheduled jobs need (QuotaService + runUsageJob; injected for tests). */
export interface WorkerJobs {
  rollover(now?: Date): Promise<{ period: string; created: number }>;
  sweepReservations(now?: Date): Promise<number>;
  expireAdjustments(now?: Date): Promise<number>;
  aggregateUsage(now?: Date): Promise<{ period: string; added: number; alerts: number }>;
  /** Knowledge Base (M12): extract, chunk, embed one document; throws to be retried. */
  ingestKbDocument(documentId: string): Promise<{ status: string }>;
  /** Monthly report (M16) of the month that just ended, or of `period`. */
  monthlyReport(period?: string): Promise<{ period: string; final: boolean; totalCost: number }>;
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

  /** Cloud Tasks (queue uniai-kb-ingest): one knowledge-base document per task. */
  @Post('kb-ingest')
  @HttpCode(200)
  async ingest(@Body() body: { documentId?: unknown }) {
    const documentId = typeof body?.documentId === 'string' ? body.documentId : '';
    if (!/^[A-Za-z0-9]{1,64}$/.test(documentId)) return { status: 'invalid' };
    const result = await this.jobs.ingestKbDocument(documentId);
    this.logger.log(JSON.stringify({ job: 'kb-ingest', documentId, ...result }));
    return result;
  }

  /** 1st of the month, 01:15 Vietnam time: store the report of the month that ended (M16). */
  @Post('monthly-report')
  @HttpCode(200)
  async monthlyReport(@Body() body: { period?: unknown }) {
    const period =
      typeof body?.period === 'string' && /^\d{4}(0[1-9]|1[0-2])$/.test(body.period)
        ? body.period
        : undefined;
    const result = await this.jobs.monthlyReport(period);
    this.logger.log(JSON.stringify({ job: 'monthly-report', ...result }));
    return result;
  }

  /** Every 5 minutes: fold the ledger into dashboard totals, update budgets, raise alerts. */
  @Post('usage-aggregate')
  @HttpCode(200)
  async aggregate() {
    const result = await this.jobs.aggregateUsage();
    this.logger.log(JSON.stringify({ job: 'usage-aggregate', ...result }));
    return result;
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
          const {
            getDb,
            GcsBlobStore,
            KnowledgeStore,
            QuotaService,
            runMonthlyReport,
            runUsageJob,
          } = await import('@uniai/firestore');
          const db = getDb();
          const quota = new QuotaService(db);
          const env =
            (process.env.FIRESTORE_DATABASE_ID ?? '(default)') === '(default)'
              ? 'production'
              : 'staging';
          return {
            rollover: (now) => quota.rollover(now),
            sweepReservations: (now) => quota.sweepReservations(now),
            expireAdjustments: (now) => quota.expireAdjustments(now),
            aggregateUsage: (now) => runUsageJob(db, now),
            monthlyReport: (period) => runMonthlyReport(db, new Date(), period),
            ingestKbDocument: async (documentId) => {
              const [{ ingestDocument }, { VertexEmbedder, MockEmbedder }] = await Promise.all([
                import('@uniai/documents'),
                import('@uniai/ai-providers'),
              ]);
              const embedder = config.gcpProject
                ? new VertexEmbedder(config.gcpProject, config.embeddingLocation)
                : new MockEmbedder();
              return ingestDocument(
                {
                  store: new KnowledgeStore(db, env),
                  blobs: new GcsBlobStore(config.filesBucket),
                  embedder,
                  maxPages: KB_MAX_PAGES,
                },
                documentId,
              );
            },
          };
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
