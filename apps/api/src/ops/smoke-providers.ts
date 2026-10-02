/**
 * Calls each registry model once with a short prompt and prints tokens and cost (M4 runbook).
 * Run by Claude Cowork in Cloud Shell; it only reads Firestore and Secret Manager.
 *
 *   pnpm ops:smoke-providers --database staging --include-disabled
 *   pnpm ops:smoke-providers --database staging --model claude-haiku-4-5 --model gpt-6-luna
 */
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import {
  createProvider,
  GcpSecretStore,
  probe,
  ProviderConfigError,
  secretNameFor,
  type SecretStore,
} from '@uniai/ai-providers';
import { getDb, RegistryStore } from '@uniai/firestore';
import { DEFAULT_TEST_PROMPT, formatUsd, usageCost, type ModelView } from '@uniai/shared';

export interface SmokeRow {
  model: string;
  route: string;
  ok: boolean;
  tokens: string;
  cost: string;
  latency: string;
  detail: string;
}

export interface SmokeOptions {
  registry: RegistryStore;
  secrets: SecretStore;
  project: string;
  location: string;
  databaseId: string;
  models: string[];
  includeDisabled: boolean;
  prompt: string;
  factory?: typeof createProvider;
}

export async function smoke(o: SmokeOptions): Promise<SmokeRow[]> {
  const factory = o.factory ?? createProvider;
  const all = await o.registry.listModels();
  const selected = all.filter(
    (m: ModelView) =>
      m.providerId !== 'mock' &&
      (o.models.length > 0 ? o.models.includes(m.id) : o.includeDisabled || m.status === 'active'),
  );
  const rows: SmokeRow[] = [];
  for (const model of selected) {
    const settings = await o.registry.getProvider(model.providerId);
    const route = `${model.providerId}/${settings.transport}`;
    const fail = (detail: string): SmokeRow => ({
      model: model.id,
      route,
      ok: false,
      tokens: '-',
      cost: '-',
      latency: '-',
      detail,
    });
    let apiKey: string | null = null;
    if (settings.keyRequired) {
      apiKey = await o.secrets.accessLatest(secretNameFor(model.providerId, o.databaseId));
      if (!apiKey) {
        rows.push(fail(`chưa có API key (${secretNameFor(model.providerId, o.databaseId)})`));
        continue;
      }
    }
    let provider;
    try {
      provider = factory({
        id: model.providerId,
        transport: settings.transport,
        apiKey,
        project: o.project,
        location: o.location,
      });
    } catch (err) {
      if (err instanceof ProviderConfigError) {
        rows.push(fail(err.message));
        continue;
      }
      throw err;
    }
    const r = await probe(provider, {
      model: model.apiModelId,
      messages: [{ role: 'user', content: o.prompt }],
      maxOutputTokens: Math.min(model.maxOutputTokens, 1024),
      reasoningEffort: model.defaultParams.reasoningEffort,
    });
    const cost = r.usage && model.currentPrice ? usageCost(r.usage, model.currentPrice) : null;
    rows.push({
      model: model.id,
      route,
      ok: !r.error,
      tokens: r.usage
        ? `${r.usage.inputTokens}+${r.usage.cachedInputTokens}c/${r.usage.outputTokens}`
        : '-',
      cost: cost === null ? '-' : `${formatUsd(cost)} (${cost} µUSD)`,
      latency: `${r.latencyMs} ms`,
      detail: r.error
        ? `${r.error.code}: ${r.error.message}`
        : `${r.stopReason}: ${r.text.replace(/\s+/g, ' ').slice(0, 80)}`,
    });
  }
  return rows;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      database: { type: 'string' },
      project: { type: 'string', default: process.env.GCLOUD_PROJECT ?? 'uniaiplatform1' },
      location: { type: 'string', default: 'global' },
      model: { type: 'string', multiple: true, default: [] },
      'include-disabled': { type: 'boolean', default: false },
      prompt: { type: 'string', default: DEFAULT_TEST_PROMPT },
    },
  });
  if (!values.database) {
    console.error(
      'Cách dùng: --database <(default)|staging> [--model <id> ...] [--include-disabled] [--prompt "..."]',
    );
    return 2;
  }
  process.env.GCLOUD_PROJECT ??= values.project;
  const registry = new RegistryStore(
    getDb({ projectId: values.project, databaseId: values.database }),
  );
  const rows = await smoke({
    registry,
    secrets: new GcpSecretStore(values.project),
    project: values.project,
    location: values.location,
    databaseId: values.database,
    models: values.model,
    includeDisabled: values['include-disabled'],
    prompt: values.prompt,
  });
  if (rows.length === 0) {
    console.log('Không có model nào để thử (thêm --include-disabled để thử cả model đang tắt).');
    return 0;
  }
  console.log(
    `Project ${values.project}, database ${values.database}, Vertex AI ${values.location}`,
  );
  console.table(rows);
  const failed = rows.filter((r) => !r.ok).length;
  console.log(
    failed ? `${failed}/${rows.length} model lỗi.` : `Cả ${rows.length} model trả lời được.`,
  );
  return failed ? 1 : 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    },
  );
}
