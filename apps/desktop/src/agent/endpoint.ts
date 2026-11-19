import { Channel, invoke } from '@tauri-apps/api/core';
import { fromAnthropicResult, toAnthropicRequest, toAnthropicTools, type AnthropicMessageResult } from './anthropic';
import type { AgentAssistantMessage, ApiFormat, AuthScheme } from './types';
import type { ChatCompletionMessageParam, ChatCompletionResponse, ChatCompletionTool } from './wire-types';

/** Progress the native gateway reports while it reads a streamed reply. */
export type ChatCompletionStreamEvent =
  | { type: 'delta'; content: string }
  | { type: 'tool'; name: string }
  | { type: 'activity' };

export interface ModelTurnRequest {
  format: ApiFormat;
  baseUrl: string;
  apiKey: string;
  authScheme?: AuthScheme;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
}

export interface ModelTurn {
  message: AgentAssistantMessage;
  /** `finish_reason` (OpenAI) or `stop_reason` (Anthropic). */
  stopReason: string | null;
  /** Provider explanation for a refusal, when it sends one. */
  stopDetail?: string;
}

export interface ModelInfo { id: string; displayName: string }

type EndpointLeaf = '/chat/completions' | '/messages' | '/models';
const ENDPOINT_LEAVES: EndpointLeaf[] = ['/chat/completions', '/messages', '/models'];

/**
 * Mirror of the native endpoint rules: an origin or a `/v1` path gets the
 * standard leaf; a URL that already names a full endpoint keeps its path.
 */
export function normalizeModelEndpoint(baseUrl: string, leaf: EndpointLeaf): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) throw new Error('Base URL is required.');

  const parsed = new URL(trimmed);
  const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLocalhost)) {
    throw new Error('Base URL must use HTTPS (HTTP is allowed only for localhost).');
  }
  if (parsed.username || parsed.password) {
    throw new Error('Base URL must not contain credentials.');
  }
  if (parsed.search || parsed.hash) {
    throw new Error('Base URL must not contain a query string or fragment.');
  }

  const path = parsed.pathname.replace(/\/+$/, '');
  const known = ENDPOINT_LEAVES.find((candidate) => path.endsWith(candidate));
  const root = known ? path.slice(0, -known.length) : path.endsWith('/v1') ? path : `${path}/v1`;
  parsed.pathname = `${root}${leaf}`;
  return parsed.toString();
}

export function normalizeChatCompletionUrl(baseUrl: string): string {
  return normalizeModelEndpoint(baseUrl, '/chat/completions');
}

function requireDesktop(): void {
  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('The model gateway is available from the Tauri desktop runtime only.');
  }
}

/**
 * Request one model turn through the native gateway. Streamed progress goes to
 * `onEvent` until the request settles; aborting `signal` cancels the native
 * request, which closes the connection so the provider stops generating.
 */
export async function requestModelTurn(
  request: ModelTurnRequest,
  onEvent?: (event: ChatCompletionStreamEvent) => void,
  signal?: AbortSignal,
): Promise<ModelTurn> {
  if (!request.apiKey.trim()) throw new Error('An API key is required to run the Agent.');
  if (!request.model.trim()) throw new Error('A model name is required to run the Agent.');
  requireDesktop();

  const requestId = crypto.randomUUID();
  let settled = false;
  const channel = new Channel<ChatCompletionStreamEvent>();
  // Channel messages and the command result travel separately; drop progress
  // that lands after the result so it cannot overwrite the final text.
  channel.onmessage = (event) => { if (!settled && !signal?.aborted) onEvent?.(event); };
  const cancel = () => { void invoke('cancel_model_request', { requestId }).catch(() => {}); };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    const shared = { requestId, apiKey: request.apiKey, model: request.model.trim() };
    if (request.format === 'anthropic') {
      const { system, messages } = toAnthropicRequest(request.messages);
      const result = await invoke<AnthropicMessageResult>('anthropic_message', {
        request: {
          ...shared,
          baseUrl: normalizeModelEndpoint(request.baseUrl, '/messages'),
          authScheme: request.authScheme ?? 'apiKey',
          system,
          messages,
          tools: toAnthropicTools(request.tools),
        },
        onEvent: channel,
      });
      const explanation = result.stop_details?.explanation;
      return {
        message: fromAnthropicResult(result),
        stopReason: result.stop_reason,
        ...(explanation ? { stopDetail: explanation } : {}),
      };
    }
    // Sampling and token limits are left to the provider: reasoning models
    // reject a non-default temperature and some count reasoning in max_tokens.
    const response = await invoke<ChatCompletionResponse>('chat_completion', {
      request: {
        ...shared,
        baseUrl: normalizeChatCompletionUrl(request.baseUrl),
        messages: request.messages,
        tools: request.tools,
      },
      onEvent: channel,
    });
    const choice = response.choices?.[0];
    if (!choice?.message) throw new Error('The model endpoint returned no assistant message.');
    return { message: choice.message, stopReason: choice.finish_reason ?? null };
  } finally {
    settled = true;
    signal?.removeEventListener('abort', cancel);
  }
}

/** List an endpoint's models. Costs no tokens, so it doubles as a connection check. */
export async function listModels(request: { format: ApiFormat; baseUrl: string; apiKey: string; authScheme?: AuthScheme }): Promise<ModelInfo[]> {
  if (!request.apiKey.trim()) throw new Error('An API key is required to run the Agent.');
  requireDesktop();
  return invoke<ModelInfo[]>('list_models', {
    request: {
      format: request.format,
      baseUrl: normalizeModelEndpoint(request.baseUrl, '/models'),
      apiKey: request.apiKey,
      authScheme: request.authScheme ?? 'apiKey',
    },
  });
}
