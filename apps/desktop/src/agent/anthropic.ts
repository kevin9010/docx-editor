import type { AgentAssistantMessage } from './types';
import type { ChatCompletionMessageParam, ChatCompletionTool } from './wire-types';

/** A Messages API content block. Unknown block types pass through untouched. */
export interface AnthropicContentBlock {
  type: string;
  [key: string]: unknown;
}

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

export interface AnthropicToolParam {
  name: string;
  description: string;
  input_schema: Record<string, unknown>;
}

/** What the native `anthropic_message` command returns. */
export interface AnthropicMessageResult {
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  stop_details?: { category?: string | null; explanation?: string | null } | null;
  model?: string | null;
}

export function toAnthropicTools(tools: ChatCompletionTool[]): AnthropicToolParam[] {
  return tools.map(({ function: tool }) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

function parseArguments(serialized: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(serialized);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

/**
 * Convert the loop's provider-neutral history into a Messages API request.
 * Assistant turns that came from this API are replayed from their original
 * content blocks, so thinking blocks and their signatures go back unchanged and
 * the history stays append-only. Tool results answering one assistant turn are
 * returned together in a single user message.
 */
export function toAnthropicRequest(messages: ChatCompletionMessageParam[]): { system: string; messages: AnthropicMessageParam[] } {
  const system = messages
    .filter((message) => message.role === 'system' && message.content)
    .map((message) => message.content)
    .join('\n\n');
  const converted: AnthropicMessageParam[] = [];
  for (const message of messages) {
    if (message.role === 'system') continue;
    if (message.role === 'tool') {
      const result: AnthropicContentBlock = { type: 'tool_result', tool_use_id: message.tool_call_id ?? '', content: message.content ?? '' };
      const previous = converted.at(-1);
      if (previous?.role === 'user' && Array.isArray(previous.content) && previous.content.every((block) => block.type === 'tool_result')) {
        previous.content.push(result);
      } else {
        converted.push({ role: 'user', content: [result] });
      }
      continue;
    }
    if (message.role === 'assistant') {
      const content: AnthropicContentBlock[] = message.anthropic_content
        ? message.anthropic_content as AnthropicContentBlock[]
        : [
            ...(message.content ? [{ type: 'text', text: message.content }] : []),
            ...(message.tool_calls ?? []).map((call) => ({
              type: 'tool_use',
              id: call.id,
              name: call.function.name,
              input: parseArguments(call.function.arguments),
            })),
          ];
      if (content.length > 0) converted.push({ role: 'assistant', content });
      continue;
    }
    converted.push({ role: 'user', content: message.content ?? '' });
  }
  return { system, messages: converted };
}

/** Map a Messages API reply onto the loop's assistant message, keeping the original blocks for replay. */
export function fromAnthropicResult(result: AnthropicMessageResult): AgentAssistantMessage {
  const text = result.content
    .filter((block) => block.type === 'text' && typeof block.text === 'string' && block.text)
    .map((block) => block.text as string)
    .join('\n\n');
  const toolCalls = result.content
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({
      id: String(block.id),
      type: 'function' as const,
      function: { name: String(block.name), arguments: JSON.stringify(block.input ?? {}) },
    }));
  return {
    role: 'assistant',
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    anthropic_content: result.content,
  };
}
