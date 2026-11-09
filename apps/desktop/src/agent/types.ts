import type { BrowserDocumentApi } from 'superdoc';
import type { ChatCompletionMessageParam, ChatCompletionTool } from './wire-types';
import type { SelectionTarget } from '@superdoc/document-api';

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
  status: 'applied' | 'proposed' | 'failed' | 'no_match' | 'invalid' | 'aborted';
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
  onText?: (text: string) => void;
  onActivity?: () => void;
  onDiagnostic?: (diagnostic: AgentDiagnostic | null) => void;
  review?: AgentReviewSession;
}

export interface AgentDiagnostic {
  title: string;
  hint: string;
  detail: string;
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
  review?: AgentReviewSession;
}

export interface AgentSelection {
  text: string;
  target: SelectionTarget;
  revision: string;
}

export interface AgentProposal {
  id: string;
  action: 'replace_text' | 'add_comment';
  find: string;
  replacement?: string;
  comment?: string;
  state: 'pending' | 'applying' | 'applied' | 'dismissed' | 'failed';
  error?: string;
}

export interface AgentReviewSession {
  revision: string;
  selection?: AgentSelection;
  selectionReplaced?: boolean;
  proposals: AgentProposal[];
  onProposal?: (proposal: AgentProposal) => void;
}

export type AgentToolDefinitions = ChatCompletionTool[];
export type AgentMessages = ChatCompletionMessageParam[];
