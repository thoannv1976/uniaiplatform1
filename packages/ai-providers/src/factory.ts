import type { AuthClient } from 'google-auth-library';
import { AnthropicProvider } from './anthropic.js';
import { GeminiProvider } from './gemini.js';
import { MockProvider } from './mock.js';
import { OpenAIProvider } from './openai.js';
import type { LLMProvider, ProviderId, Transport } from './types.js';

export interface ProviderConnection {
  id: ProviderId;
  transport: Transport;
  /** Required for the direct transport of real vendors. */
  apiKey?: string | null;
  /** GCP project and Vertex AI location for the vertex transport. */
  project?: string;
  location?: string;
  authClient?: AuthClient;
  /** For tests: replays recorded HTTP. */
  fetch?: typeof fetch;
}

export class ProviderConfigError extends Error {}

/** Builds the adapter for a provider's current settings ("add a provider = add an adapter"). */
export function createProvider(c: ProviderConnection): LLMProvider {
  if (c.id === 'mock') return new MockProvider();
  if (c.transport === 'direct') {
    if (!c.apiKey) throw new ProviderConfigError(`Chưa nhập API key cho ${c.id}`);
    const apiKey = c.apiKey;
    if (c.id === 'openai') return new OpenAIProvider({ apiKey, fetch: c.fetch });
    if (c.id === 'anthropic')
      return new AnthropicProvider({ transport: 'direct', apiKey, fetch: c.fetch });
    return new GeminiProvider({ transport: 'direct', apiKey, fetch: c.fetch });
  }
  if (!c.project || !c.location) {
    throw new ProviderConfigError('Thiếu GCP project hoặc vùng Vertex AI');
  }
  if (c.id === 'anthropic') {
    return new AnthropicProvider({
      transport: 'vertex',
      projectId: c.project,
      region: c.location,
      authClient: c.authClient,
      fetch: c.fetch,
    });
  }
  if (c.id === 'gemini') {
    return new GeminiProvider({
      transport: 'vertex',
      project: c.project,
      location: c.location,
      authClient: c.authClient,
      fetch: c.fetch,
    });
  }
  throw new ProviderConfigError(`${c.id} không hỗ trợ gọi qua Vertex AI`);
}
