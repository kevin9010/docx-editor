import { requestChatCompletion } from './endpoint';
import { dispatchAgentTool, AGENT_SYSTEM_PROMPT, AGENT_TOOLS, toolResultMessage } from './tools';
import type { AgentAssistantMessage, AgentMessages, AgentRunOptions, AgentRunResult } from './types';

const DEFAULT_MAX_TURNS = 8;
const MAX_TOOL_CALLS_PER_TURN = 4;

function assistantMessage(message: AgentAssistantMessage): AgentMessages[number] {
  return {
    role: 'assistant',
    content: message.content,
    ...(message.tool_calls ? { tool_calls: message.tool_calls } : {}),
  };
}

export async function runDocumentAgent(options: AgentRunOptions): Promise<AgentRunResult> {
  const maxTurns = Math.max(1, Math.min(options.maxTurns ?? DEFAULT_MAX_TURNS, 16));
  const messages: AgentMessages = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    { role: 'user', content: options.prompt },
  ];
  let mutated = false;

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (options.signal?.aborted) {
      return { status: 'aborted', summary: 'The Agent run was cancelled.', turns: turn - 1, mutated };
    }
    options.onStatus?.(`Asking the model (turn ${turn}/${maxTurns})…`);

    let response: Awaited<ReturnType<typeof requestChatCompletion>>;
    try {
      response = await requestChatCompletion({
        baseUrl: options.baseUrl,
        apiKey: options.apiKey,
        model: options.model,
        messages,
        tools: AGENT_TOOLS,
        temperature: 0.1,
        maxTokens: 1200,
      });
    } catch (error) {
      return {
        status: options.signal?.aborted ? 'aborted' : 'failed',
        summary: error instanceof Error ? error.message : 'The model request failed.',
        turns: turn,
        mutated,
      };
    }
    const message = response.choices[0]?.message;
    if (!message) throw new Error('The model response did not contain a message.');

    messages.push(assistantMessage(message));
    const calls = message.tool_calls ?? [];
    if (calls.length === 0) {
      return {
        status: 'completed',
        summary: message.content?.trim() || 'The Agent completed without a final message.',
        turns: turn,
        mutated,
      };
    }

    if (calls.length > MAX_TOOL_CALLS_PER_TURN) {
      return {
        status: 'failed',
        summary:
          `The Agent requested ${calls.length} tool calls in one turn; `
          + `the safety limit is ${MAX_TOOL_CALLS_PER_TURN}.`,
        turns: turn,
        mutated,
      };
    }

    for (const call of calls) {
      if (options.signal?.aborted) {
        return { status: 'aborted', summary: 'The Agent run was cancelled.', turns: turn, mutated };
      }
      options.onStatus?.(`Running ${call.function.name}…`);
      let parsedInput: unknown;
      try {
        parsedInput = JSON.parse(call.function.arguments);
      } catch {
        parsedInput = null;
      }
      let result;
      try {
        result = await dispatchAgentTool(
          { document: options.document, signal: options.signal },
          call.function.name,
          parsedInput,
        );
      } catch (error) {
        result = {
          status: 'failed' as const,
          message: error instanceof Error ? error.message : 'The document tool failed.',
        };
      }
      if (result.status === 'applied' && result.receipt) mutated = true;
      messages.push(toolResultMessage(call.id, result));
    }
  }

  return {
    status: 'max_turns',
    summary: `The Agent stopped after ${maxTurns} turns. Review any tracked changes before continuing.`,
    turns: maxTurns,
    mutated,
  };
}
