import type { AgentDocument, AgentProposal, AgentReviewSession } from './types';

export async function applyProposal(document: AgentDocument, review: AgentReviewSession, proposal: AgentProposal, approvedText?: string): Promise<void> {
  if (proposal.state !== 'pending') throw new Error('This suggestion is no longer pending.');
  const text = approvedText ?? (proposal.action === 'replace_text' ? proposal.replacement : proposal.comment) ?? '';
  if (text.length > 16_000) throw new Error('Keep the suggestion within 16,000 characters.');
  if (proposal.action === 'add_comment' && !text.trim()) throw new Error('Enter a comment before applying it.');
  if (proposal.action === 'replace_text' && text === proposal.find) throw new Error('The suggested text is identical to the original.');
  const info = await document.info({});
  if (info.revision !== review.revision) {
    throw new Error('The document changed after these suggestions were generated. Run the Agent again before applying them.');
  }
  if (review.selectionReplaced) throw new Error('The selected text has already been replaced. Select it again for another edit.');

  // A review session may be Vue-reactive. Worker-backed document APIs cannot
  // structured-clone a Proxy, so pass a plain public target across the boundary.
  let target = review.selection ? JSON.parse(JSON.stringify(review.selection.target)) : undefined;
  if (!target) {
    const matches = await document.query.match({
      select: { type: 'text', pattern: proposal.find, mode: 'contains', caseSensitive: true },
      require: 'all', limit: 2,
    });
    if (matches.items.length !== 1 || matches.items[0].matchKind !== 'text') {
      throw new Error('The original text is missing or occurs more than once. Select the intended passage and try again.');
    }
    // Query handles carry an opaque package revision; info() exposes the live
    // editor revision. Compare like with like, then let expectedRevision guard
    // the final mutation atomically.
    if ((await document.info({})).revision !== review.revision) throw new Error('The document changed while locating this suggestion.');
    target = matches.items[0].target;
  }

  proposal.state = 'applying';
  try {
    const receipt = proposal.action === 'replace_text'
      ? await document.replace({ target, text }, { changeMode: 'tracked', expectedRevision: review.revision })
      : await document.comments.create({ target, text, author: 'SuperDoc Agent', authorEmail: 'agent@local' }, { expectedRevision: review.revision });
    const after = await document.info({});
    if (receipt.success !== true || after.revision === review.revision) {
      throw new Error('The document did not confirm this edit. Review the document before trying again.');
    }
    review.revision = after.revision;
    if (proposal.action === 'replace_text') proposal.replacement = text;
    else proposal.comment = text;
    if (review.selection && proposal.action === 'replace_text') review.selectionReplaced = true;
    proposal.state = 'applied';
  } catch (error) {
    proposal.state = 'failed';
    proposal.error = error instanceof Error ? error.message : 'Could not apply this suggestion.';
    throw error;
  }
}
