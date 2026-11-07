import { describe, expect, it, vi } from 'vitest';
import { CodexClient, runCodexAgent, type RpcMessage } from './codex';
import type { AgentDocument, AgentRunOptions } from './types';

function options(): AgentRunOptions {
  return { document: { info: vi.fn(async () => ({ revision: 'r1' })), getText: vi.fn(async () => 'Fictional sentence.') } as unknown as AgentDocument, review: { revision: 'r1', proposals: [] }, prompt: 'Inspect', model: '', baseUrl: '', apiKey: '' };
}

describe('Codex app-server bridge client', () => {
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

  it('dispatches dynamic document tools, streams text and ends a completed turn', async () => {
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
});
