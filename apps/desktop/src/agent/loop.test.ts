import { describe, expect, it, vi } from 'vitest';
import { requestChatCompletion } from './endpoint';
import { runDocumentAgent } from './loop';
import type { AgentDocument } from './types';

vi.mock('./endpoint', () => ({ requestChatCompletion: vi.fn() }));

describe('Base URL Agent cancellation', () => {
  it('stops immediately and ignores a late model response', async () => {
    const controller = new AbortController();
    let respond!: (value: Awaited<ReturnType<typeof requestChatCompletion>>) => void;
    vi.mocked(requestChatCompletion).mockImplementation(() => new Promise((resolve) => { respond = resolve; }));
    const onText = vi.fn();
    const run = runDocumentAgent({ document: {} as AgentDocument, baseUrl: 'https://example.test', apiKey: 'test', model: 'test', prompt: 'Polish', signal: controller.signal, onText });
    controller.abort();
    expect((await run).status).toBe('aborted');
    respond({ choices: [{ message: { role: 'assistant', content: 'Too late' } }] });
    await Promise.resolve();
    expect(onText).not.toHaveBeenCalled();
  });

  it('shows streamed text as it arrives without repeating the final message', async () => {
    vi.mocked(requestChatCompletion).mockImplementation(async (_request, onEvent) => {
      onEvent?.({ type: 'delta', content: 'Pol' });
      onEvent?.({ type: 'delta', content: 'ished.' });
      return { choices: [{ message: { role: 'assistant', content: 'Polished.' } }] };
    });
    const onText = vi.fn();
    const onActivity = vi.fn();
    const result = await runDocumentAgent({ document: {} as AgentDocument, baseUrl: 'https://example.test', apiKey: 'test', model: 'test', prompt: 'Polish', onText, onActivity });
    expect(result).toMatchObject({ status: 'completed', summary: 'Polished.' });
    expect(onText.mock.calls.map(([text]) => text)).toEqual(['Pol', 'Polished.']);
    expect(onActivity).toHaveBeenCalled();
  });

  it('reports how many suggestions are ready when the turn budget runs out', async () => {
    vi.mocked(requestChatCompletion).mockResolvedValue({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'unknown_tool', arguments: '{}' } }] } }] });
    const review = { revision: 'r1', proposals: [{ id: 'p', action: 'replace_text' as const, find: 'a', replacement: 'b', state: 'pending' as const }] };
    const result = await runDocumentAgent({ document: {} as AgentDocument, baseUrl: 'https://example.test', apiKey: 'test', model: 'test', prompt: 'Polish', maxTurns: 2, review });
    expect(result.status).toBe('max_turns');
    expect(result.summary).toContain('all 2 turns');
    expect(result.summary).toContain('1 suggestion(s)');
  });
});
