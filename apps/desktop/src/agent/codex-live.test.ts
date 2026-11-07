import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { CodexClient, runCodexAgent } from './codex';
import type { AgentDocument, AgentReviewSession } from './types';

// Opt in with an absolute executable path. No real document or credentials are
// included in this test; the installed CLI owns authentication and routing.
it.skipIf(!process.env.SUPERDOC_TEST_CODEX)('uses installed Codex to propose a revision through the document tool protocol', async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), 'superdoc-codex-test-'));
  const child = spawn(process.env.SUPERDOC_TEST_CODEX!, ['app-server', '--listen', 'stdio://', '-c', 'mcp_servers={}'], { cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = createInterface({ input: child.stdout });
  const client = new CodexClient({
    send: async (message) => {
      if (message.method === 'thread/start') message.params = { ...message.params, cwd: workspace, ephemeral: true, environments: [], sandbox: 'read-only', approvalPolicy: 'never', config: { mcp_servers: {}, web_search: 'disabled', skills: { include_instructions: false }, features: { apps: false } } };
      if (message.method === 'turn/start') message.params = { ...message.params, environments: [] };
      child.stdin.write(JSON.stringify(message) + '\n');
    },
    close: async () => {
      lines.close();
      if (child.exitCode !== null || child.signalCode !== null) return;
      await new Promise<void>((resolve) => { child.once('exit', () => resolve()); child.kill(); });
    },
  });
  lines.on('line', (line) => client.receive(JSON.parse(line)));
  child.on('error', (error) => client.receive({ method: 'bridge/closed', params: { message: error.message } }));
  child.on('exit', () => client.receive({ method: 'bridge/closed', params: { message: 'Process exited' } }));
  const review: AgentReviewSession = { revision: 'r1', proposals: [] };
  const document = {
    info: async () => ({ revision: 'r1' }), getText: async () => 'The fictional team are ready.',
    query: { match: async () => ({ evaluatedRevision: 'r1', items: [{ matchKind: 'text', target: { kind: 'range' } }] }) },
    replace: async () => { throw new Error('A model must not write the document directly.'); },
  } as unknown as AgentDocument;
  try {
    await client.request('initialize', { clientInfo: { name: 'superdoc_desktop_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    await client.send({ method: 'initialized', params: {} });
    const result = await runCodexAgent(client, { document, review, model: '', baseUrl: '', apiKey: '', prompt: 'This is a synthetic integration test. Call superdoc_inspect with includeText true, then call superdoc_perform_action to replace exactly "The fictional team are ready." with "The fictional team is ready.". This must be a proposed change for review, not an applied edit. End with one short sentence.' });
    expect(result.status, result.summary).toBe('completed');
    expect(review.proposals).toEqual([expect.objectContaining({ find: 'The fictional team are ready.', replacement: 'The fictional team is ready.', state: 'pending' })]);
  } finally {
    await client.close();
    if (path.dirname(workspace) === path.resolve(tmpdir()) && path.basename(workspace).startsWith('superdoc-codex-test-')) {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}, 180_000);
