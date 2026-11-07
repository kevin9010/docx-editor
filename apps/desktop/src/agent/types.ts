import type { BrowserDocumentApi } from 'superdoc';
import type { ChatCompletionMessageParam, ChatCompletionTool } from './wire-types';

export type MaybePromise<T> = T | Promise<T>;

export type AgentDocument = Pick<BrowserDocumentApi, 'getText' | 'info' | 'query' | 'replace' | 'comments'>;

export type AgentToolName = 'superdoc_inspect' | 'superdoc_perform_action';

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface AgentAssistantMessage {
  role: 'assistant';
  content: string | null;
  tool_calls?: AgentToolCall[];
}

export interface AgentToolResult {
  status: 'applied' | 'failed' | 'no_match' | 'invalid' | 'aborted';
  message?: string;
  [key: string]: unknown;
}

export interface AgentRunOptions {
  document: AgentDocument;
  prompt: string;
  model: string;
  baseUrl: string;
  apiKey: string;
  maxTurns?: number;
  signal?: AbortSignal;
  onStatus?: (status: string) => void;
}

export interface AgentRunResult {
  status: 'completed' | 'failed' | 'aborted' | 'max_turns';
  summary: string;
  turns: number;
  mutated: boolean;
}

export interface AgentToolContext {
  document: AgentDocument;
  signal?: AbortSignal;
}

export type AgentToolDefinitions = ChatCompletionTool[];
export type AgentMessages = ChatCompletionMessageParam[];
