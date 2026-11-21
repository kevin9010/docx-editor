import { beforeEach, describe, expect, it, vi } from 'vitest';
import { requestModelTurn, type ModelTurn } from './endpoint';
import { runDocumentAgent } from './loop';
import type { AgentDocument, AgentRunOptions } from './types';

vi.mock('./endpoint', () => ({ requestModelTurn: vi.fn() }));

function run(overrides: Partial<AgentRunOptions> = {}) {
  return runDocumentAgent({ document: {} as AgentDocument, baseUrl: 'https://example.test', apiKey: 'test', model: 'test', prompt: 'Polish', ...overrides });
}

function textTurn(content: string, stopReason: string | null = 'stop'): ModelTurn {
  return { message: { role: 'assistant', content }, stopReason };
}

describe('Base URL Agent loop', () => {
  beforeEach(() => { vi.mocked(requestModelTurn).mockReset(); });

  it('stops immediately and ignores a late model response', async () => {
    const controller = new AbortController();
    let respond!: (value: ModelTurn) => void;
    vi.mocked(requestModelTurn).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const onText = vi.fn();
    const pending = run({ signal: controller.signal, onText });
    controller.abort();
    expect((await pending).status).toBe('aborted');
    respond(textTurn('Too late'));
    await Promise.resolve();
    expect(onText).not.toHaveBeenCalled();
  });

  it('passes the abort signal so the native request can be cancelled', async () => {
    const controller = new AbortController();
    vi.mocked(requestModelTurn).mockResolvedValue(textTurn('Done.'));
    await run({ signal: controller.signal, apiFormat: 'anthropic', authScheme: 'bearer' });
    const [request, , signal] = vi.mocked(requestModelTurn).mock.calls[0];
    expect(signal).toBe(controller.signal);
    expect(request).toMatchObject({ format: 'anthropic', authScheme: 'bearer' });
    expect(request).not.toHaveProperty('temperature');
  });

  it('shows streamed text as it arrives without repeating the final message', async () => {
    vi.mocked(requestModelTurn).mockImplementation(async (_request, onEvent) => {
      onEvent?.({ type: 'delta', content: 'Pol' });
      onEvent?.({ type: 'delta', content: 'ished.' });
      return textTurn('Polished.');
    });
    const onText = vi.fn();
    const onActivity = vi.fn();
    const result = await run({ onText, onActivity });
    expect(result).toMatchObject({ status: 'completed', summary: 'Polished.' });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(['Pol', 'Polished.']);
    expect(onActivity).toHaveBeenCalled();
  });

  it('reports how many suggestions are ready when the turn budget runs out', async () => {
    vi.mocked(requestModelTurn).mockResolvedValue({ stopReason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }] } });
    const review = { revision: 'r1', proposals: [{ id: 'p', action: 'replace_text' as const, find: 'a', replacement: 'b', state: 'pending' as const }] };
    const result = await run({ maxTurns: 2, review });
    expect(result.status).toBe('max_turns');
    expect(result.summary).toContain('all 2 turns');
    expect(result.summary).toContain('1 suggestion(s)');
  });

  it('stops on a refusal and on a tool call cut off by the output limit', async () => {
    vi.mocked(requestModelTurn).mockResolvedValueOnce({ ...textTurn(''), stopReason: 'refusal', stopDetail: 'Policy category.' });
    expect(await run()).toMatchObject({ status: 'failed', summary: expect.stringContaining('declined this request: Policy category.') });

    vi.mocked(requestModelTurn).mockResolvedValueOnce({ stopReason: 'max_tokens', message: { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'superdoc_inspect', arguments: '{"incl' } }] } });
    expect(await run()).toMatchObject({ status: 'failed', summary: expect.stringContaining('output limit') });
    expect(requestModelTurn).toHaveBeenCalledTimes(2);
  });

  it('replays Anthropic content blocks unchanged on the next turn', async () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'tool_use', id: 'toolu_1', name: 'unknown_tool', input: {} },
    ];
    vi.mocked(requestModelTurn)
      .mockResolvedValueOnce({ stopReason: 'tool_use', message: { role: 'assistant', content: null, tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }], anthropic_content: blocks } })
      .mockResolvedValueOnce(textTurn('Done.', 'end_turn'));
    expect((await run({ apiFormat: 'anthropic' })).status).toBe('completed');
    const secondRequest = vi.mocked(requestModelTurn).mock.calls[1][0];
    expect(secondRequest.messages[2]).toMatchObject({ role: 'assistant', anthropic_content: blocks });
    expect(secondRequest.messages[3]).toMatchObject({ role: 'tool', tool_call_id: 'toolu_1' });
  });
});
