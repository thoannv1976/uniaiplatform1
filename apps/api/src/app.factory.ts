import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppOverrides } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(
  config: AppConfig,
  options: { quiet?: boolean; overrides?: AppOverrides } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.forRoot(config, options.overrides),
    {
      logger: options.quiet ? false : ['error', 'warn', 'log'],
    },
  );
  // CSV imports are sent as JSON; 1,000 staff rows are ~100 KB, so allow up to 6 MB.
  app.useBodyParser('json', { limit: '6mb' });
  app.enableCors({
    origin: config.webOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  return app;
}
