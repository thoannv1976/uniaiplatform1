import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { AppModule, type AppOverrides } from './app.module.js';
import type { AppConfig } from './config.js';

export async function createApp(
  config: AppConfig,
  options: { quiet?: boolean; overrides?: AppOverrides } = {},
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, options.overrides), {
    logger: options.quiet ? false : ['error', 'warn', 'log'],
  });
  app.enableCors({
    origin: config.webOrigins,
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
  });
  app.enableShutdownHooks();
  return app;
}
