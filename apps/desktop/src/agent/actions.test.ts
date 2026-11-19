import { describe, expect, it } from 'vitest';
import { agentRunBudget } from './actions';

describe('agentRunBudget', () => {
  it('keeps the original limits for a selection or short document', () => {
    expect(agentRunBudget(0)).toEqual({ maxTurns: 8, timeLimitMs: 5 * 60_000 });
    expect(agentRunBudget(12_000)).toEqual({ maxTurns: 8, timeLimitMs: 5 * 60_000 });
  });

  it('grows with the number of excerpts a long document needs', () => {
    expect(agentRunBudget(60_000)).toEqual({ maxTurns: 11, timeLimitMs: 13 * 60_000 });
  });

  it('caps very long documents', () => {
    expect(agentRunBudget(5_000_000)).toEqual({ maxTurns: 24, timeLimitMs: 15 * 60_000 });
  });
});
