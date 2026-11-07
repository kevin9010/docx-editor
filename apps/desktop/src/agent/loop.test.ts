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
});
