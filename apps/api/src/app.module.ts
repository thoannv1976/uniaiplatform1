import { Module, type DynamicModule } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from './config.js';
import { HealthController } from './health/health.controller.js';

@Module({})
export class AppModule {
  static forRoot(config: AppConfig): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController],
      providers: [{ provide: APP_CONFIG, useValue: config }],
    };
  }
}
