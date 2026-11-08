import { Channel, invoke } from '@tauri-apps/api/core';
import { AGENT_SYSTEM_PROMPT, AGENT_TOOLS, dispatchAgentTool, toolResultMessage } from './tools';
import { withAbort } from './cancellation';
import type { AgentRunOptions, AgentRunResult, AgentToolResult } from './types';

export interface RpcMessage {
  id?: string | number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { code?: number; message: string };
}

interface Transport {
  send(message: RpcMessage): Promise<void>;
  close(): Promise<void>;
}

export interface CodexModel { model: string; displayName: string; isDefault: boolean }
export interface CodexStatus { executable: string; signedIn: boolean; models: CodexModel[] }

export class CodexClient {
  private nextId = 0;
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private listeners = new Set<(message: RpcMessage) => void>();
  private closed = false;
  private closePromise: Promise<void> | null = null;
  onRequest: ((message: RpcMessage) => Promise<void>) | null = null;

  constructor(private transport: Transport, readonly executable = '') {}

  receive(message: RpcMessage): void {
    if (this.closed) return;
    if (message.method === 'bridge/closed') {
      this.fail(new Error(String(message.params?.message ?? 'Codex disconnected.')));
      return;
    }
    if (typeof message.id === 'number' && !message.method) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    } else if (message.id !== undefined && message.method) {
      const handler = this.onRequest;
      void (handler ? handler(message) : this.replyUnsupported(message)).catch(() => {});
    } else {
      for (const listener of this.listeners) listener(message);
    }
  }

  request<T = Record<string, unknown>>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.closed) return Promise.reject(new Error('Codex is disconnected.'));
    const id = ++this.nextId;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex did not respond to ${method}. Reconnect and try again.`));
      }, 45_000);
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
      void this.transport.send({ id, method, params }).catch((error: unknown) => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  send(message: RpcMessage): Promise<void> { return this.transport.send(message); }
  subscribe(listener: (message: RpcMessage) => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }
  replyUnsupported(message: RpcMessage): Promise<void> {
    return this.send({ id: message.id, error: { code: -32601, message: 'This document assistant only supports its supplied document tools. No external action was approved.' } });
  }
  private fail(error: Error): void {
    this.closed = true;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
    for (const listener of this.listeners) listener({ method: 'bridge/closed', params: { message: error.message } });
    this.listeners.clear();
  }
  async close(): Promise<void> {
    if (!this.closePromise) {
      this.fail(new Error('Codex connection closed.'));
      this.closePromise = this.transport.close();
    }
    await this.closePromise;
  }
}

export async function connectCodex(executable = '', signal?: AbortSignal, onStatus?: (status: string) => void): Promise<CodexClient> {
  if (!('__TAURI_INTERNALS__' in window)) throw new Error('Local Codex is available in the desktop app. The browser preview cannot launch local programs.');
  let client: CodexClient | null = null;
  const earlyMessages: RpcMessage[] = [];
  const channel = new Channel<RpcMessage>();
  channel.onmessage = (message) => { if (client) client.receive(message); else earlyMessages.push(message); };
  onStatus?.('Starting the installed Codex CLI…');
  const starting = invoke<{sessionId: string; executable: string}>('codex_start', { executable: executable || null, onEvent: channel });
  // A process that starts after cancellation still needs to be reclaimed.
  void starting.then((connection) => { if (signal?.aborted) return invoke('codex_stop', { sessionId: connection.sessionId }); }).catch(() => {});
  const connection = await withAbort(starting, signal);
  client = new CodexClient({
    send: (message) => invoke('codex_send', { sessionId: connection.sessionId, message }),
    close: () => invoke('codex_stop', { sessionId: connection.sessionId }),
  }, connection.executable);
  for (const message of earlyMessages) client.receive(message);
  try {
    onStatus?.('Codex started. Initializing the connection…');
    await withAbort(client.request('initialize', { clientInfo: { name: 'superdoc_desktop', title: 'SuperDoc Desktop', version: '0.1.0' }, capabilities: { experimentalApi: true } }), signal);
    await client.send({ method: 'initialized', params: {} });
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

export async function inspectCodex(client: CodexClient, includeModels = true, onStatus?: (status: string) => void): Promise<CodexStatus> {
  onStatus?.('Checking the existing Codex login…');
  const account = await client.request<{ account: unknown; requiresOpenaiAuth: boolean }>('account/read', { refreshToken: false });
  const models: CodexModel[] = [];
  if (!includeModels) return { executable: client.executable, signedIn: Boolean(account.account) || !account.requiresOpenaiAuth, models };
  onStatus?.('Loading available Codex models…');
  let cursor: string | null = null;
  do {
    const result: {data: CodexModel[]; nextCursor: string | null} = await client.request('model/list', { limit: 100, ...(cursor ? { cursor } : {}) });
    models.push(...result.data);
    cursor = result.nextCursor;
  } while (cursor && models.length < 500);
  return { executable: client.executable, signedIn: Boolean(account.account) || !account.requiresOpenaiAuth, models };
}

export async function runCodexAgent(client: CodexClient, options: AgentRunOptions): Promise<AgentRunResult> {
  let threadId = '';
  let turnId = '';
  let toolCount = 0;
  let finished = false;
  let lastActivity = Date.now();
  const activity = () => { lastActivity = Date.now(); options.onActivity?.(); };
  const status = (message: string) => { activity(); options.onStatus?.(message); };
  const toolAbort = new AbortController();
  let toolQueue = Promise.resolve();
  const messages = new Map<string, string>();
  let finish!: (result: AgentRunResult) => void;
  const completion = new Promise<AgentRunResult>((resolve) => { finish = (result) => { if (!finished) { finished = true; resolve(result); } }; });
  const result = (status: AgentRunResult['status'], summary: string): AgentRunResult => ({ status, summary, turns: 1, mutated: false });
  const cancel = () => {
    toolAbort.abort();
    if (threadId && turnId) void client.request('turn/interrupt', { threadId, turnId }).catch(() => {});
    finish(result('aborted', 'The Agent run was cancelled. Pending suggestions remain available for review.'));
  };
  const timeout = setTimeout(() => finish(result('failed', 'Codex exceeded the five-minute limit. Review any suggestions before trying again.')), 300_000);
  const idleTimeout = setInterval(() => {
    if (Date.now() - lastActivity >= 120_000) finish(result('failed', 'No Codex activity for two minutes. The run was stopped. Check the Codex provider connection or choose another model, then retry. Existing suggestions are still available.'));
  }, 1000);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const unsubscribe = client.subscribe((message) => {
    const params = message.params ?? {};
    if (finished) return;
    if (message.method === 'bridge/closed') { finish(result('failed', String(params.message))); return; }
    if (params.threadId !== threadId) return;
    activity();
    if (message.method === 'turn/started') { turnId = String((params.turn as {id?: string})?.id ?? ''); status('Codex accepted the request. Waiting for the model…'); }
    if (message.method === 'error') {
      const detail = String((params.error as {message?: string})?.message ?? 'Codex provider error.');
      status(params.willRetry ? `Connection interrupted; Codex is retrying. ${detail}` : detail);
      if (!params.willRetry) finish(result('failed', detail));
    }
    if (message.method === 'item/started') {
      const item = params.item as {type?: string};
      if (item?.type === 'reasoning') status('The model is processing your request…');
      if (item?.type === 'agentMessage') status('Receiving the model response…');
    }
    if (message.method === 'thread/status/changed') {
      const next = params.status as {type?: string; activeFlags?: string[]};
      if (next?.type === 'systemError') finish(result('failed', 'Codex reported a system error. Check its provider connection and retry.'));
      if (next?.activeFlags?.length) status('Codex is waiting for an external action. You can stop and retry with document-only instructions.');
    }
    if (message.method === 'item/agentMessage/delta') {
      options.onStatus?.('Receiving the model response…');
      const id = String(params.itemId);
      messages.set(id, (messages.get(id) ?? '') + String(params.delta ?? ''));
      options.onText?.([...messages.values()].join('\n\n'));
    }
    if (message.method === 'item/completed') {
      const item = params.item as { type?: string; id?: string; text?: string };
      if (item?.type === 'agentMessage' && item.text) { messages.set(String(item.id), item.text); options.onText?.([...messages.values()].join('\n\n')); }
    }
    if (message.method === 'turn/completed') {
      const turn = params.turn as {status?: string; error?: {message?: string}};
      finish(result(turn?.status === 'completed' ? 'completed' : turn?.status === 'interrupted' ? 'aborted' : 'failed', turn?.error?.message || [...messages.values()].join('\n\n') || 'Codex finished. Review the suggestions below.'));
    }
  });
  client.onRequest = async (message) => {
    if (message.method !== 'item/tool/call' || message.params?.threadId !== threadId) {
      status('Codex requested an unsupported action; only document tools are available.');
      return client.replyUnsupported(message);
    }
    toolQueue = toolQueue.catch(() => {}).then(async () => {
      const params = message.params!;
      const tool = String(params.tool);
      status(tool === 'superdoc_inspect' ? 'Reading the selected document context…' : 'Preparing a suggestion for review…');
      let output: AgentToolResult;
      try {
        output = finished || options.signal?.aborted || ++toolCount > 64
          ? { status: 'aborted', message: 'This run has stopped or reached its tool limit.' }
          : await dispatchAgentTool({ document: options.document, signal: toolAbort.signal, review: options.review }, tool, params.arguments);
      } catch (error) { output = { status: 'failed', message: error instanceof Error ? error.message : 'The document tool failed.' }; }
      if (finished || options.signal?.aborted) return;
      await client.send({ id: message.id, result: { success: ['applied', 'proposed'].includes(output.status), contentItems: [{ type: 'inputText', text: toolResultMessage(String(message.id), output).content }] } });
      status(output.status === 'proposed' ? 'Suggestion ready. Waiting for Codex to finish; you can stop and review now.' : output.status === 'applied' ? 'Document context sent. Waiting for the model…' : `Document tool: ${output.message ?? output.status}`);
    });
    try { await toolQueue; } catch (error) { finish(result('failed', error instanceof Error ? error.message : 'Could not return the document tool result to Codex.')); }
  };
  try {
    if (options.signal?.aborted) { cancel(); return await completion; }
    status('Creating a Codex document session…');
    if (!options.review) throw new Error('A document review session is required.');
    const thread = await Promise.race([client.request<{thread: {id: string}; model?: string}>('thread/start', {
      ...(options.model ? { model: options.model } : {}), baseInstructions: AGENT_SYSTEM_PROMPT,
      dynamicTools: AGENT_TOOLS.map(({function: tool}) => ({ type: 'function', name: tool.name, description: tool.description, inputSchema: tool.parameters })),
    }), completion]);
    if ('status' in thread) return thread;
    threadId = thread.thread.id;
    status(`Sending your instruction to ${thread.model || options.model || 'the CLI default model'}…`);
    if (finished || options.signal?.aborted) { cancel(); return await completion; }
    const turn = await Promise.race([client.request<{turn: {id: string}}>('turn/start', { threadId, input: [{type:'text', text:options.prompt}] }), completion]);
    if ('status' in turn) return turn;
    turnId = turn.turn.id;
    if (options.signal?.aborted) cancel();
    return await completion;
  } catch (error) {
    return result(options.signal?.aborted ? 'aborted' : 'failed', error instanceof Error ? error.message : 'Codex failed.');
  } finally {
    finished = true;
    toolAbort.abort();
    clearTimeout(timeout);
    clearInterval(idleTimeout);
    options.signal?.removeEventListener('abort', cancel);
    unsubscribe();
    client.onRequest = null;
    await client.close().catch(() => {});
  }
}
