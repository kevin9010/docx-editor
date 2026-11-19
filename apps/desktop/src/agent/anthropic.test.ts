import { describe, expect, it } from 'vitest';
import { fromAnthropicResult, toAnthropicRequest, toAnthropicTools } from './anthropic';
import { AGENT_TOOLS } from './tools';

describe('Anthropic Messages API mapping', () => {
  it('moves the system prompt out and batches tool results into one user message', () => {
    const { system, messages } = toAnthropicRequest([
      { role: 'system', content: 'Be precise.' },
      { role: 'user', content: 'Polish' },
      { role: 'assistant', content: 'Reading.', tool_calls: [
        { id: 'a', type: 'function', function: { name: 'superdoc_inspect', arguments: '{"includeText":true}' } },
        { id: 'b', type: 'function', function: { name: 'superdoc_inspect', arguments: 'not json' } },
      ] },
      { role: 'tool', tool_call_id: 'a', content: '{"status":"applied"}' },
      { role: 'tool', tool_call_id: 'b', content: '{"status":"invalid"}' },
    ]);
    expect(system).toBe('Be precise.');
    expect(messages).toEqual([
      { role: 'user', content: 'Polish' },
      { role: 'assistant', content: [
        { type: 'text', text: 'Reading.' },
        { type: 'tool_use', id: 'a', name: 'superdoc_inspect', input: { includeText: true } },
        { type: 'tool_use', id: 'b', name: 'superdoc_inspect', input: {} },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'a', content: '{"status":"applied"}' },
        { type: 'tool_result', tool_use_id: 'b', content: '{"status":"invalid"}' },
      ] },
    ]);
  });

  it('replays original content blocks, including thinking signatures, verbatim', () => {
    const original = [
      { type: 'thinking', thinking: '', signature: 'EqQB' },
      { type: 'redacted_thinking', data: 'opaque' },
      { type: 'text', text: 'Checking.' },
      { type: 'tool_use', id: 'toolu_1', name: 'superdoc_inspect', input: { findText: 'a/b' } },
    ];
    const message = fromAnthropicResult({ content: original, stop_reason: 'tool_use' });
    expect(message).toMatchObject({
      content: 'Checking.',
      tool_calls: [{ id: 'toolu_1', type: 'function', function: { name: 'superdoc_inspect', arguments: '{"findText":"a/b"}' } }],
    });
    const { messages } = toAnthropicRequest([{ role: 'user', content: 'Go' }, message]);
    expect(messages[1].content).toBe(original);
  });

  it('maps a text-only reply and skips empty text blocks', () => {
    expect(fromAnthropicResult({ content: [{ type: 'text', text: '' }, { type: 'text', text: 'Done.' }], stop_reason: 'end_turn' }))
      .toMatchObject({ content: 'Done.' });
    expect(fromAnthropicResult({ content: [], stop_reason: 'end_turn' }).tool_calls).toBeUndefined();
  });

  it('converts tool definitions to input_schema form', () => {
    const tools = toAnthropicTools(AGENT_TOOLS);
    expect(tools.map((tool) => tool.name)).toEqual(['superdoc_inspect', 'superdoc_perform_action']);
    expect(tools[1].input_schema).toBe(AGENT_TOOLS[1].function.parameters);
    expect(tools[0]).not.toHaveProperty('type');
  });
});
