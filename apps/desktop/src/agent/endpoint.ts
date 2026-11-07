import { invoke } from '@tauri-apps/api/core';
import type { ChatCompletionMessageParam, ChatCompletionResponse, ChatCompletionTool } from './wire-types';

export interface ChatCompletionRequest {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: ChatCompletionMessageParam[];
  tools: ChatCompletionTool[];
  maxTokens?: number;
  temperature?: number;
}

const COMPLETIONS_PATH = '/v1/chat/completions';

export function normalizeChatCompletionUrl(baseUrl: string): string {
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

  const pathname = parsed.pathname.replace(/\/+$/, '');
  if (pathname.endsWith('/chat/completions')) return parsed.toString().replace(/\/+$/, '');
  if (pathname.endsWith('/v1')) {
    parsed.pathname = `${pathname}/chat/completions`;
  } else {
    parsed.pathname = `${pathname}${COMPLETIONS_PATH}`;
  }
  return parsed.toString().replace(/\/+$/, '');
}

export async function requestChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  if (!request.apiKey.trim()) throw new Error('An API key is required to run the Agent.');
  if (!request.model.trim()) throw new Error('A model name is required to run the Agent.');

  if (!('__TAURI_INTERNALS__' in window)) {
    throw new Error('The model gateway is available from the Tauri desktop runtime only.');
  }

  const response = await invoke<ChatCompletionResponse>('chat_completion', {
    request: {
      ...request,
      baseUrl: normalizeChatCompletionUrl(request.baseUrl),
      model: request.model.trim(),
      apiKey: request.apiKey,
    },
  });

  if (!response.choices?.[0]?.message) {
    throw new Error('The model endpoint returned no assistant message.');
  }
  return response;
}
