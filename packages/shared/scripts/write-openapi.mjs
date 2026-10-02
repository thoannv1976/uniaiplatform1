// Writes docs/platform/openapi.json from the Zod schemas (run: pnpm --filter @uniai/shared openapi).
import { writeFileSync } from 'node:fs';
import { buildPlatformOpenApi } from '../dist/index.js';

const target = new URL('../../../docs/platform/openapi.json', import.meta.url);
writeFileSync(target, `${JSON.stringify(buildPlatformOpenApi(), null, 2)}\n`);
console.log(`Đã ghi ${target.pathname}`);
