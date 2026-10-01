import { Controller, Get, Inject } from '@nestjs/common';
import type { HealthResponse } from '@uniai/shared';
import { Public } from '../auth/decorators.js';
import { APP_CONFIG, type AppConfig } from '../config.js';

@Controller()
export class HealthController {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  @Get('healthz')
  @Public()
  health(): HealthResponse {
    return {
      status: 'ok',
      service: this.config.serviceName,
      version: this.config.version,
      time: new Date().toISOString(),
    };
  }
}
