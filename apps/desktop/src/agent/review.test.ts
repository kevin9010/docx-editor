import { describe, expect, it, vi } from 'vitest';
import { applyProposal } from './review';
import { dispatchAgentTool } from './tools';
import type { AgentDocument, AgentProposal, AgentReviewSession, AgentSelection } from './types';

function fixture() {
  let revision = 'r1';
  const target = { kind: 'range', start: 10, end: 20 };
  const document = {
    info: vi.fn(async () => ({ revision })),
    getText: vi.fn(async () => 'First passage. Second passage.'),
    query: { match: vi.fn(async () => ({ evaluatedRevision: revision, items: [{ matchKind: 'text', target }] })) },
    replace: vi.fn(async () => { revision += 'x'; return { success: true }; }),
    comments: { create: vi.fn(async () => { revision += 'x'; return { success: true }; }) },
  } as unknown as AgentDocument;
  const review: AgentReviewSession = { revision, proposals: [] };
  const proposal: AgentProposal = { id: 'p1', action: 'replace_text', find: 'First passage.', replacement: 'Better passage.', state: 'pending' };
  return { document, review, proposal, setRevision: (value: string) => { revision = value; } };
}

describe('review before changing the document', () => {
  it('queues and deduplicates a suggestion without modifying the document', async () => {
    const { document, review, proposal } = fixture();
    for (let count = 0; count < 2; count++) {
      expect((await dispatchAgentTool({ document, review }, 'superdoc_perform_action', proposal)).status).toBe('proposed');
    }
    expect(review.proposals).toHaveLength(1);
    expect(document.replace).not.toHaveBeenCalled();
    expect(document.comments.create).not.toHaveBeenCalled();
    await applyProposal(document, review, review.proposals[0]);
    expect(document.replace).toHaveBeenCalledWith(expect.objectContaining({ text: 'Better passage.' }), { changeMode: 'tracked', expectedRevision: 'r1' });
    expect(review.proposals[0].state).toBe('applied');
  });

  it('rejects ambiguous text before proposing or applying', async () => {
    const { document, review, proposal } = fixture();
    vi.mocked(document.query.match).mockResolvedValue({ items: [{ matchKind: 'text' }, { matchKind: 'text' }] } as never);
    expect((await dispatchAgentTool({ document, review }, 'superdoc_perform_action', proposal)).status).toBe('no_match');
    await expect(applyProposal(document, review, proposal)).rejects.toThrow('more than once');
    expect(document.replace).not.toHaveBeenCalled();
  });

  it('rejects a stale document and a change during target resolution', async () => {
    const { document, review, proposal, setRevision } = fixture();
    setRevision('r2');
    await expect(applyProposal(document, review, proposal)).rejects.toThrow('document changed');
    setRevision('r1');
    vi.mocked(document.query.match).mockImplementation(async () => { setRevision('r2'); return { evaluatedRevision: 'package:2', items: [{ matchKind: 'text', target: {} }] } as never; });
    await expect(applyProposal(document, review, proposal)).rejects.toThrow('while locating');
    expect(document.replace).not.toHaveBeenCalled();
  });

  it('applies independent suggestions against the revision produced by the previous approval', async () => {
    const { document, review, proposal } = fixture();
    await applyProposal(document, review, proposal);
    await applyProposal(document, review, { ...proposal, id: 'p2', find: 'Second passage.', state: 'pending' });
    expect(document.replace).toHaveBeenLastCalledWith(expect.anything(), { changeMode: 'tracked', expectedRevision: 'r1x' });
    await expect(applyProposal(document, review, proposal)).rejects.toThrow('no longer pending');
  });

  it('does not confuse opaque query revisions with live editor revisions', async () => {
    const { document, review, proposal } = fixture();
    vi.mocked(document.query.match).mockResolvedValue({ evaluatedRevision: 'opaque:pkg:1', items: [{ matchKind: 'text', target: {} }] } as never);
    await applyProposal(document, review, proposal);
    expect(proposal.state).toBe('applied');
  });

  it('uses the frozen selection even when identical text occurs elsewhere', async () => {
    const { document, review, proposal } = fixture();
    review.selection = { text: proposal.find, revision: 'r1', target: { kind: 'selection', start: 'captured-start', end: 'captured-end' } } as unknown as AgentSelection;
    const inspect = await dispatchAgentTool({ document, review }, 'superdoc_inspect', { includeText: true });
    expect(inspect.text).toBe(proposal.find);
    expect(document.getText).not.toHaveBeenCalled();
    expect((await dispatchAgentTool({ document, review }, 'superdoc_perform_action', { ...proposal, find: 'Other text' })).status).toBe('invalid');
    await applyProposal(document, review, proposal);
    expect(document.query.match).not.toHaveBeenCalled();
    expect(document.replace).toHaveBeenCalledWith({ target: review.selection.target, text: proposal.replacement }, { changeMode: 'tracked', expectedRevision: 'r1' });
    await expect(applyProposal(document, review, { ...proposal, state: 'pending' })).rejects.toThrow('already been replaced');
  });

  it('adds a comment only on approval and requires a confirmed edit', async () => {
    const { document, review, proposal } = fixture();
    await applyProposal(document, review, { ...proposal, action: 'add_comment', comment: 'Clarify this.' });
    expect(document.comments.create).toHaveBeenCalledWith(expect.objectContaining({ text: 'Clarify this.' }), { expectedRevision: 'r1' });
    vi.mocked(document.replace).mockResolvedValue({ success: false } as never);
    await expect(applyProposal(document, review, proposal)).rejects.toThrow('did not confirm');
    expect(proposal.state).toBe('failed');
  });

  it('does not enqueue a suggestion if cancelled during a document query', async () => {
    const { document, review, proposal } = fixture();
    const controller = new AbortController();
    vi.mocked(document.query.match).mockImplementation(async () => { controller.abort(); return { items: [{ matchKind: 'text' }] } as never; });
    expect((await dispatchAgentTool({ document, review, signal: controller.signal }, 'superdoc_perform_action', proposal)).status).toBe('aborted');
    expect(review.proposals).toHaveLength(0);
  });

  it('reads long documents in bounded, successive excerpts', async () => {
    const { document, review } = fixture();
    vi.mocked(document.getText).mockResolvedValue('a'.repeat(12_000) + 'last paragraph');
    const first = await dispatchAgentTool({ document, review }, 'superdoc_inspect', { includeText: true });
    expect(first.nextTextOffset).toBe(12_000);
    const second = await dispatchAgentTool({ document, review }, 'superdoc_inspect', { includeText: true, textOffset: first.nextTextOffset });
    expect(second.text).toBe('last paragraph');
    expect(second.nextTextOffset).toBeNull();
  });
});
