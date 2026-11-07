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
