import { afterEach, describe, expect, it, vi } from 'vitest';
import { CodexClient, inspectCodex, runCodexAgent, type RpcMessage } from './codex';
import type { AgentDocument, AgentRunOptions } from './types';

function options(): AgentRunOptions {
  return { document: { info: vi.fn(async () => ({ revision: 'r1' })), getText: vi.fn(async () => 'Fictional sentence.') } as unknown as AgentDocument, review: { revision: 'r1', proposals: [] }, prompt: 'Inspect', model: '', baseUrl: '', apiKey: '' };
}

function completedRunClient() {
  const sent: RpcMessage[] = [];
  const close = vi.fn(async () => {});
  let threadCount = 0;
  const client = new CodexClient({ close, send: async (message) => {
    sent.push(message);
    if (message.method === 'thread/start') {
      client.receive({ id: message.id, result: { thread: { id: `thread-${++threadCount}` } } });
    }
    if (message.method === 'turn/start') {
      client.receive({ id: message.id, result: { turn: { id: `turn-${threadCount}` } } });
      client.receive({ method: 'turn/completed', params: { threadId: message.params?.threadId, turn: { status: 'completed' } } });
    }
    if (message.method === 'thread/unsubscribe') client.receive({ id: message.id, result: {} });
  } });
  return { client, sent, close };
}

describe('Codex model selection', () => {
  it('omits the model for the CLI default without discovering or selecting a model', async () => {
    const { client, sent } = completedRunClient();
    expect((await runCodexAgent(client, options())).status).toBe('completed');
    expect(sent.find((message) => message.method === 'thread/start')?.params).not.toHaveProperty('model');
    expect(sent.map((message) => message.method)).toEqual(['thread/start', 'turn/start', 'thread/unsubscribe']);
    await client.close();
  });

  it('forwards an arbitrary full custom model identifier exactly without a discovered-model allowlist', async () => {
    const { client, sent } = completedRunClient();
    const model = 'custom-provider/docx-review-2099-11-20:preview@v2';
    expect((await runCodexAgent(client, { ...options(), model })).status).toBe('completed');
    expect(sent.find((message) => message.method === 'thread/start')?.params).toHaveProperty('model', model);
    expect(sent.some((message) => message.method === 'model/list')).toBe(false);
    await client.close();
  });

  it.each([
    ['custom-provider/reviewer-v1', 'another-provider/reviewer-v2'],
    ['custom-provider/reviewer-v1', ''],
  ])('respects model changes from %j to %j on the same warm client', async (firstModel, secondModel) => {
    const { client, sent, close } = completedRunClient();
    for (const model of [firstModel, secondModel]) {
      expect((await runCodexAgent(client, { ...options(), model })).status).toBe('completed');
      expect(client.isClosed).toBe(false);
    }
    const threads = sent.filter((message) => message.method === 'thread/start');
    expect(threads.map((message) => message.params?.model)).toEqual([firstModel, secondModel || undefined]);
    if (!secondModel) expect(threads[1].params).not.toHaveProperty('model');
    expect(sent.filter((message) => message.method === 'turn/start').map((message) => message.params?.threadId)).toEqual(['thread-1', 'thread-2']);
    expect(sent.filter((message) => message.method === 'thread/unsubscribe').map((message) => message.params?.threadId)).toEqual(['thread-1', 'thread-2']);
    expect(close).not.toHaveBeenCalled();
    await client.close();
  });
});

describe('Codex model normalization', () => {
  it.each([' ', '\t\r\n', '   '])('uses the CLI default for whitespace-only model %j', async (model) => {
    const { client, sent } = completedRunClient();
    expect((await runCodexAgent(client, { ...options(), model })).status).toBe('completed');
    expect(sent.find((message) => message.method === 'thread/start')?.params).not.toHaveProperty('model');
    await client.close();
  });

  it('trims surrounding whitespace while preserving the full custom model identifier', async () => {
    const { client, sent } = completedRunClient();
    const model = 'custom-provider/docx-review-2099-11-20:preview@v2';
    expect((await runCodexAgent(client, { ...options(), model: ` \t${model}\r\n` })).status).toBe('completed');
    expect(sent.find((message) => message.method === 'thread/start')?.params).toHaveProperty('model', model);
    await client.close();
  });
});

describe('Codex model discovery', () => {
  it.each([
    { account: { id: 'fixture-account' }, requiresOpenaiAuth: true, signedIn: true },
    { account: null, requiresOpenaiAuth: false, signedIn: true },
    { account: null, requiresOpenaiAuth: true, signedIn: false },
  ])('skips model discovery and preserves sign-in status for %j', async ({ account, requiresOpenaiAuth, signedIn }) => {
    const sent: RpcMessage[] = [];
    const client = new CodexClient({ close: vi.fn(async () => {}), send: async (message) => {
      sent.push(message);
      client.receive({ id: message.id, result: { account, requiresOpenaiAuth } });
    } }, 'fixture-codex');
    expect(await inspectCodex(client, false)).toEqual({ executable: 'fixture-codex', signedIn, models: [] });
    expect(sent).toEqual([{ id: 1, method: 'account/read', params: { refreshToken: false } }]);
    await client.close();
  });

  it('follows model pagination cursors without replacing custom or default model identifiers', async () => {
    const sent: RpcMessage[] = [];
    const first = { model: 'custom-provider/first:preview', displayName: 'First', isDefault: false };
    const second = { model: 'custom-provider/second@v2', displayName: 'Second', isDefault: true };
    const client = new CodexClient({ close: vi.fn(async () => {}), send: async (message) => {
      sent.push(message);
      const result = message.method === 'account/read'
        ? { account: null, requiresOpenaiAuth: false }
        : message.params?.cursor === 'page-2'
          ? { data: [second], nextCursor: null }
          : { data: [first], nextCursor: 'page-2' };
      client.receive({ id: message.id, result });
    } }, 'fixture-codex');
    expect(await inspectCodex(client)).toEqual({ executable: 'fixture-codex', signedIn: true, models: [first, second] });
    expect(sent.filter((message) => message.method === 'model/list').map((message) => message.params)).toEqual([{ limit: 100 }, { limit: 100, cursor: 'page-2' }]);
    await client.close();
  });
});

describe('Codex app-server bridge client', () => {
  afterEach(() => vi.useRealTimers());
  it('correlates concurrent requests and forwards server errors', async () => {
    const send = vi.fn(async (_message: RpcMessage) => {});
    const client = new CodexClient({ send, close: vi.fn(async () => {}) });
    const first = client.request('account/read', {});
    const second = client.request('model/list', {});
    const rejected = expect(first).rejects.toThrow('No account');
    client.receive({ id: 2, result: { data: [] } });
    client.receive({ id: 1, error: { message: 'No account' } });
    await rejected;
    expect(await second).toEqual({ data: [] });
    await client.close();
  });

  it('rejects pending requests on disconnect and closes the transport once', async () => {
    const close = vi.fn(async () => {});
    const client = new CodexClient({ send: vi.fn(async () => {}), close });
    const request = client.request('initialize', {});
    const rejected = expect(request).rejects.toThrow('Lost process');
    client.receive({ method: 'bridge/closed', params: { message: 'Lost process' } });
    await rejected;
    await client.close();
    await client.close();
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('dispatches dynamic document tools, streams text and keeps the process for the next run', async () => {
    const sent: RpcMessage[] = [];
    const close = vi.fn(async () => {});
    const client = new CodexClient({ close, send: async (message) => {
      sent.push(message);
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 'thread' } } });
      if (message.method === 'turn/start') {
        client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
        client.receive({ id: 'call-1', method: 'item/tool/call', params: { threadId: 'thread', tool: 'superdoc_inspect', arguments: { includeText: true } } });
      }
      if (message.id === 'call-1') {
        client.receive({ method: 'item/agentMessage/delta', params: { threadId: 'thread', itemId: 'answer', delta: 'Reviewed.' } });
        client.receive({ method: 'turn/completed', params: { threadId: 'thread', turn: { status: 'completed' } } });
      }
    } });
    const onText = vi.fn();
    const result = await runCodexAgent(client, { ...options(), onText });
    expect(result.status).toBe('completed');
    expect(result.summary).toBe('Reviewed.');
    expect(onText).toHaveBeenCalledWith('Reviewed.');
    expect(sent.find((message) => message.id === 'call-1')?.result).toMatchObject({ success: true, contentItems: [{ type: 'inputText', text: expect.stringContaining('Fictional sentence.') }] });
    expect(sent.find((message) => message.method === 'thread/start')?.params).not.toHaveProperty('model');
    expect(sent.find((message) => message.method === 'thread/unsubscribe')?.params).toEqual({ threadId: 'thread' });
    expect(close).not.toHaveBeenCalled();
    expect(client.isClosed).toBe(false);
    await client.close();
  });

  it('appends streamed deltas and joins separate agent messages', async () => {
    const client = new CodexClient({ close: vi.fn(async () => {}), send: async (message) => {
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') {
        client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
        for (const delta of ['Fir', 'st']) client.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'a', delta } });
        client.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'b', delta: 'Second' } });
        client.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'a', delta: '!' } });
        client.receive({ method: 'turn/completed', params: { threadId: 't', turn: { status: 'completed' } } });
      }
    } });
    const onText = vi.fn();
    const result = await runCodexAgent(client, { ...options(), onText });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(['Fir', 'First', 'First\n\nSecond', 'First!\n\nSecond']);
    expect(result.summary).toBe('First!\n\nSecond');
    await client.close();
  });

  it('uses the caller time limit and closes the process after a timeout', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const client = new CodexClient({ close, send: async (message) => {
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
    } });
    const run = runCodexAgent(client, { ...options(), timeLimitMs: 60_000, onActivity: () => {} });
    for (let second = 0; second < 61; second += 30) {
      client.receive({ method: 'item/started', params: { threadId: 't', item: { type: 'reasoning' } } });
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect((await run).summary).toContain('1-minute limit');
    expect(close).toHaveBeenCalledOnce();
  });

  it('cancels while thread creation is pending without waiting for its timeout', async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {});
    const client = new CodexClient({ close, send: vi.fn(async () => {}) });
    const run = runCodexAgent(client, { ...options(), signal: controller.signal });
    controller.abort();
    expect((await run).status).toBe('aborted');
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails a run when the local process disconnects', async () => {
    const client = new CodexClient({ close: vi.fn(async () => {}), send: async () => { client.receive({ method: 'bridge/closed', params: { message: 'Disconnected' } }); } });
    expect((await runCodexAgent(client, options())).status).toBe('failed');
  });

  it('reports processing and retries, then fails promptly on a terminal provider error', async () => {
    const client = new CodexClient({ close: vi.fn(async () => {}), send: async (message) => {
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 't' }, model: 'configured-model' } });
      if (message.method === 'turn/start') {
        client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
        client.receive({ method: 'item/started', params: { threadId: 't', item: { type: 'reasoning' } } });
        client.receive({ method: 'error', params: { threadId: 't', willRetry: true, error: { message: 'Stream interrupted' } } });
        client.receive({ method: 'error', params: { threadId: 't', willRetry: false, error: { message: 'Provider unavailable' } } });
      }
    } });
    const onStatus = vi.fn();
    const result = await runCodexAgent(client, { ...options(), onStatus });
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('configured-model'));
    expect(onStatus).toHaveBeenCalledWith('The model is processing your request…');
    expect(onStatus).toHaveBeenCalledWith(expect.stringContaining('retrying'));
    expect(result).toMatchObject({ status: 'failed', summary: 'Provider unavailable' });
  });

  it('stops a silent provider and resets the inactivity timer on server activity', async () => {
    vi.useFakeTimers();
    const close = vi.fn(async () => {});
    const client = new CodexClient({ close, send: async (message) => {
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
    } });
    const onActivity = vi.fn();
    const run = runCodexAgent(client, { ...options(), onActivity });
    await vi.advanceTimersByTimeAsync(110_000);
    client.receive({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 't', delta: 'ignored' } });
    await vi.advanceTimersByTimeAsync(110_000);
    expect(close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(10_000);
    expect((await run).summary).toContain('No Codex activity');
    expect(onActivity).toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it('stops after five consecutive retries and retains the provider cause', async () => {
    const close = vi.fn(async () => {});
    const client = new CodexClient({ close, send: async (message) => {
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') {
        client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
        for (let attempt = 1; attempt <= 5; attempt++) client.receive({ method: 'error', params: { threadId: 't', willRetry: true, error: { message: `Reconnecting... ${attempt}/100`, additionalDetails: 'Concurrency limit exceeded for user' } } });
      }
    } });
    const onDiagnostic = vi.fn();
    expect(await runCodexAgent(client, { ...options(), onDiagnostic })).toMatchObject({ status: 'failed', summary: expect.stringContaining('Concurrency limit exceeded') });
    expect(onDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ title: expect.stringContaining('concurrent request limit') }));
    expect(close).toHaveBeenCalledOnce();
  });

  it('clears recovered diagnostics, resets consecutive retries, and preserves terminal error details', async () => {
    const client = new CodexClient({ close: vi.fn(async () => {}), send: async (message) => {
      if (message.method === 'thread/start') client.receive({ id: message.id, result: { thread: { id: 't' } } });
      if (message.method === 'turn/start') {
        client.receive({ id: message.id, result: { turn: { id: 'turn' } } });
        const retry = () => client.receive({ method: 'error', params: { threadId: 't', willRetry: true, error: { message: 'Reconnecting...', additionalDetails: 'Connection reset' } } });
        for (let n = 0; n < 4; n++) retry();
        client.receive({ method: 'item/agentMessage/delta', params: { threadId: 't', itemId: 'answer', delta: 'Working' } });
        for (let n = 0; n < 4; n++) retry();
        client.receive({ method: 'turn/completed', params: { threadId: 't', turn: { status: 'failed', error: { message: 'Request failed', additionalDetails: 'Model access denied', codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 403 } } } } } });
      }
    } });
    const onDiagnostic = vi.fn();
    const result = await runCodexAgent(client, { ...options(), onDiagnostic });
    expect(onDiagnostic).toHaveBeenCalledWith(null);
    expect(result).toMatchObject({ status: 'failed', summary: expect.stringContaining('Model access denied') });
    expect(onDiagnostic).toHaveBeenLastCalledWith(expect.objectContaining({ title: expect.stringContaining('authentication') }));
  });
});
