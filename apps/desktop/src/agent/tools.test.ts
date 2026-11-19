import { describe, expect, it, vi } from 'vitest';
import { dispatchAgentTool } from './tools';
import type { AgentDocument } from './types';

function createDocument(overrides: Partial<AgentDocument> = {}): AgentDocument {
  const info = vi.fn().mockResolvedValue({ revision: 'r2' });
  return {
    info,
    getText: vi.fn().mockResolvedValue('A bounded document excerpt.'),
    query: {
      match: vi.fn().mockResolvedValue({
        evaluatedRevision: 'r1',
        items: [{ id: 'match-1', matchKind: 'text', snippet: 'old text', target: { kind: 'range', start: 1, end: 2 } }],
      }),
    },
    replace: vi.fn().mockResolvedValue({ status: 'applied', success: true }),
    comments: {
      create: vi.fn().mockResolvedValue({ status: 'applied', success: true }),
    },
    ...overrides,
  } as AgentDocument;
}

describe('document Agent tools', () => {
  it('rejects tools that are not in the allowlist', async () => {
    const result = await dispatchAgentTool({ document: createDocument() }, 'delete_file', {});
    expect(result).toEqual({ status: 'invalid', message: 'Tool is not advertised: delete_file' });
  });

  it('re-queries and applies replacements in tracked mode', async () => {
    const document = createDocument();
    const result = await dispatchAgentTool(
      { document },
      'superdoc_perform_action',
      { action: 'replace_text', find: 'old text', replacement: 'new text' },
    );

    expect(result.status).toBe('applied');
    expect(document.replace).toHaveBeenCalledWith(
      { target: { kind: 'range', start: 1, end: 2 }, text: 'new text' },
      { changeMode: 'tracked', expectedRevision: 'r1' },
    );
  });

  it('does not report partial receipts as successful', async () => {
    const document = createDocument({ replace: vi.fn().mockResolvedValue({ status: 'partial' }) });
    const result = await dispatchAgentTool(
      { document },
      'superdoc_perform_action',
      { action: 'replace_text', find: 'old text', replacement: 'new text' },
    );
    expect(result.status).toBe('failed');
  });

  it('requires comments to produce a successful revision-changing receipt', async () => {
    const document = createDocument({
      info: vi.fn().mockResolvedValue({ revision: 'r1' }),
    });
    const result = await dispatchAgentTool(
      { document },
      'superdoc_perform_action',
      { action: 'add_comment', find: 'old text', comment: 'Review this clause.' },
    );
    expect(result.status).toBe('failed');
    expect(result.revisionChanged).toBe(false);
  });

  it('applies comments when the document revision changes', async () => {
    const document = createDocument();
    const result = await dispatchAgentTool(
      { document },
      'superdoc_perform_action',
      { action: 'add_comment', find: 'old text', comment: 'Review this clause.' },
    );
    expect(result.status).toBe('applied');
    expect(result.revisionChanged).toBe(true);
    expect(document.comments.create).toHaveBeenCalledWith({
      target: { kind: 'range', start: 1, end: 2 },
      text: 'Review this clause.',
      author: 'SuperDoc Agent',
      authorEmail: 'agent@local',
    });
  });

  it('falls back to a case-insensitive search and flags it for the model', async () => {
    const hit = { evaluatedRevision: 'r1', items: [{ id: 'm', matchKind: 'text', snippet: 'Old Text', target: { kind: 'range', start: 1, end: 2 }, handle: { ref: 'h' } }] };
    const match = vi.fn().mockResolvedValueOnce({ evaluatedRevision: 'r1', items: [] }).mockResolvedValueOnce(hit);
    const document = createDocument({ query: { match } as unknown as AgentDocument['query'] });
    const result = await dispatchAgentTool({ document }, 'superdoc_inspect', { findText: 'old text' });
    expect(match).toHaveBeenLastCalledWith(expect.objectContaining({ select: expect.objectContaining({ caseSensitive: false }) }));
    expect(result.matches).toHaveLength(1);
    expect(result.matchNote).toContain('ignore letter case');
  });

  it('shrinks a whole-document excerpt to fit the tool-result cap and pages exactly', async () => {
    const outline = Array.from({ length: 400 }, (_, index) => ({ level: 1, text: `Heading ${index}` }));
    const text = '"quoted"\n'.repeat(5000);
    const document = createDocument({
      info: vi.fn().mockResolvedValue({ revision: 'r9', outline }),
      getText: vi.fn().mockResolvedValue(text),
    });
    const result = await dispatchAgentTool({ document }, 'superdoc_inspect', { includeText: true });
    const { toolResultMessage } = await import('./tools');
    const message = toolResultMessage('call', result);
    expect(JSON.parse(message.content as string).status).toBe('applied');
    expect(result.info).toEqual({ revision: 'r9' });
    expect(result.truncated).toBe(true);
    expect(result.nextTextOffset).toBe((result.text as string).length - '\n[document text truncated]'.length);

    const last = await dispatchAgentTool({ document }, 'superdoc_inspect', { includeText: true, textOffset: text.length - 9 });
    expect(last).toMatchObject({ text: '"quoted"\n', truncated: false, nextTextOffset: null });
  });

  it('rejects overlong mutation inputs before searching', async () => {
    const document = createDocument();
    const result = await dispatchAgentTool(
      { document },
      'superdoc_perform_action',
      { action: 'replace_text', find: 'x'.repeat(12_001), replacement: 'new text' },
    );
    expect(result.status).toBe('invalid');
    expect(document.query.match).not.toHaveBeenCalled();
  });
});
