import { beforeEach, describe, expect, it, vi } from 'vitest';

const invokeMock = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
  Channel: class { onmessage: ((event: unknown) => void) | null = null; },
}));

import { listModels, normalizeChatCompletionUrl, normalizeModelEndpoint, requestModelTurn } from './endpoint';
import type { ChatCompletionStreamEvent } from './endpoint';

describe('normalizeChatCompletionUrl', () => {
  it('adds the OpenAI-compatible path to an origin', () => {
    expect(normalizeChatCompletionUrl('https://api.example.test')).toBe(
      'https://api.example.test/v1/chat/completions',
    );
  });

  it('preserves a v1 base path', () => {
    expect(normalizeChatCompletionUrl('https://gateway.example.test/v1/')).toBe(
      'https://gateway.example.test/v1/chat/completions',
    );
  });

  it('does not duplicate a complete endpoint', () => {
    expect(normalizeChatCompletionUrl('https://gateway.example.test/v1/chat/completions')).toBe(
      'https://gateway.example.test/v1/chat/completions',
    );
  });

  it('rejects unsupported protocols', () => {
    expect(() => normalizeChatCompletionUrl('file:///tmp/model')).toThrow('HTTPS');
  });

  it('allows HTTP only for loopback gateways', () => {
    expect(normalizeChatCompletionUrl('http://localhost:3000/v1')).toBe(
      'http://localhost:3000/v1/chat/completions',
    );
    expect(() => normalizeChatCompletionUrl('http://gateway.example.test/v1')).toThrow('HTTPS');
  });

  it('rejects credentials and query strings', () => {
    expect(() => normalizeChatCompletionUrl('https://user@example.test/v1')).toThrow('credentials');
    expect(() => normalizeChatCompletionUrl('https://example.test/v1?key=secret')).toThrow('query');
  });
});

describe('normalizeModelEndpoint', () => {
  it('builds Messages and model-list endpoints for gateways', () => {
    expect(normalizeModelEndpoint('https://api.anthropic.com', '/messages')).toBe('https://api.anthropic.com/v1/messages');
    expect(normalizeModelEndpoint('https://gateway.test/anthropic', '/messages')).toBe('https://gateway.test/anthropic/v1/messages');
    expect(normalizeModelEndpoint('https://gateway.test/proxy/messages', '/messages')).toBe('https://gateway.test/proxy/messages');
    expect(normalizeModelEndpoint('https://gateway.test/v1/messages', '/models')).toBe('https://gateway.test/v1/models');
  });
});

describe('requestModelTurn', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    vi.stubGlobal('window', { __TAURI_INTERNALS__: {} });
  });

  const request = {
    baseUrl: 'https://gateway.test',
    apiKey: 'key',
    model: 'magpie-1.anthropic.claude-opus-5-5',
    messages: [{ role: 'system' as const, content: 'Rules' }, { role: 'user' as const, content: 'Go' }],
    tools: [],
  };

  it('sends Anthropic requests with the chosen auth scheme and maps the reply', async () => {
    invokeMock.mockResolvedValueOnce({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' });
    const turn = await requestModelTurn({ ...request, format: 'anthropic', authScheme: 'bearer' });
    const [command, args] = invokeMock.mock.calls[0];
    expect(command).toBe('anthropic_message');
    expect(args.request).toMatchObject({
      baseUrl: 'https://gateway.test/v1/messages',
      authScheme: 'bearer',
      model: 'magpie-1.anthropic.claude-opus-5-5',
      system: 'Rules',
      messages: [{ role: 'user', content: 'Go' }],
    });
    expect(args.request.requestId).toMatch(/[0-9a-f-]{36}/);
    expect(turn).toMatchObject({ stopReason: 'end_turn', message: { content: 'Hi' } });
  });

  it('cancels the native request on abort and drops progress after the result', async () => {
    const controller = new AbortController();
    const events: ChatCompletionStreamEvent[] = [];
    let channel!: { onmessage: (event: ChatCompletionStreamEvent) => void };
    let resolveTurn!: (value: unknown) => void;
    invokeMock.mockImplementation((command: string, args: { onEvent?: typeof channel }) => {
      if (command === 'chat_completion') {
        channel = args.onEvent!;
        return new Promise((resolve) => { resolveTurn = resolve; });
      }
      return Promise.resolve();
    });
    const pending = requestModelTurn({ ...request, format: 'openai' }, (event) => events.push(event), controller.signal);
    channel.onmessage({ type: 'delta', content: 'a' });
    resolveTurn({ choices: [{ message: { role: 'assistant', content: 'a' }, finish_reason: 'stop' }] });
    await pending;
    channel.onmessage({ type: 'delta', content: 'late' });
    expect(events).toEqual([{ type: 'delta', content: 'a' }]);

    const second = requestModelTurn({ ...request, format: 'openai' }, undefined, controller.signal);
    controller.abort();
    resolveTurn({ choices: [{ message: { role: 'assistant', content: '' } }] });
    await second;
    const cancel = invokeMock.mock.calls.find(([command]) => command === 'cancel_model_request');
    expect(cancel?.[1]).toEqual({ requestId: invokeMock.mock.calls[1][1].request.requestId });
  });

  it('lists models through the native command', async () => {
    invokeMock.mockResolvedValueOnce([{ id: 'm', displayName: 'M' }]);
    await expect(listModels({ format: 'anthropic', baseUrl: 'https://gateway.test', apiKey: 'k' })).resolves.toEqual([{ id: 'm', displayName: 'M' }]);
    expect(invokeMock).toHaveBeenCalledWith('list_models', { request: { format: 'anthropic', baseUrl: 'https://gateway.test/v1/models', apiKey: 'k', authScheme: 'apiKey' } });
  });
});
