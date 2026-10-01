import { Module, type DynamicModule } from '@nestjs/common';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard.js';
import {
  FirebaseTokenVerifier,
  TOKEN_VERIFIER,
  type TokenVerifier,
} from './auth/token-verifier.js';
import { APP_CONFIG, type AppConfig } from './config.js';
import { HealthController } from './health/health.controller.js';
import { MeController } from './me/me.controller.js';

export interface AppOverrides {
  /** Replaces Firebase token verification, for unit tests. */
  tokenVerifier?: TokenVerifier;
}

@Module({})
export class AppModule {
  static forRoot(config: AppConfig, overrides: AppOverrides = {}): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, MeController],
      providers: [
        { provide: APP_CONFIG, useValue: config },
        {
          provide: TOKEN_VERIFIER,
          useValue: overrides.tokenVerifier ?? new FirebaseTokenVerifier(),
        },
        FirebaseAuthGuard,
      ],
    };
  }
}
