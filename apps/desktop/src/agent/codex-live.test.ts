import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { expect, it } from 'vitest';
import { CodexClient, runCodexAgent } from './codex';
import { buildWritingPrompt } from './actions';
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
  const academic = process.env.SUPERDOC_TEST_ACTION === 'academic';
  const source = academic ? 'We looked at how students learn online. The results show that regular feedback helps them do better, but our sample was small.' : 'The fictional team are ready.';
  const review: AgentReviewSession = { revision: 'r1', proposals: [] };
  if (academic) review.selection = { text: source, revision: 'r1', target: { kind: 'selection' } as never };
  const document = {
    info: async () => ({ revision: 'r1' }), getText: async () => source,
    query: { match: async () => ({ evaluatedRevision: 'r1', items: [{ matchKind: 'text', target: { kind: 'range' } }] }) },
    replace: async () => { throw new Error('A model must not write the document directly.'); },
  } as unknown as AgentDocument;
  try {
    await client.request('initialize', { clientInfo: { name: 'superdoc_desktop_test', version: '0.1.0' }, capabilities: { experimentalApi: true } });
    await client.send({ method: 'initialized', params: {} });
    const started = Date.now();
    let previousStatus = '';
    const heartbeat = setInterval(() => console.log(`Waiting for Codex: ${Math.floor((Date.now() - started) / 1000)}s elapsed`), 10_000);
    const result = await runCodexAgent(client, { document, review, model: '', baseUrl: '', apiKey: '', onStatus: (message) => { if (message !== previousStatus) console.log(`${Math.floor((Date.now() - started) / 1000)}s: ${message}`); previousStatus = message; }, prompt: academic ? buildWritingPrompt('academic', '', '', true) : 'This is a synthetic integration test. Call superdoc_inspect with includeText true, then call superdoc_perform_action to replace exactly "The fictional team are ready." with "The fictional team is ready.". This must be a proposed change for review, not an applied edit. End with one short sentence.' }).finally(() => clearInterval(heartbeat));
    expect(result.status, result.summary).toBe('completed');
    if (academic) {
      expect(review.proposals).toHaveLength(1);
      expect(review.proposals[0]).toMatchObject({ find: source, state: 'pending' });
      expect(review.proposals[0].replacement).not.toBe(source);
    } else expect(review.proposals).toEqual([expect.objectContaining({ find: source, replacement: 'The fictional team is ready.', state: 'pending' })]);
  } finally {
    await client.close();
    if (path.dirname(workspace) === path.resolve(tmpdir()) && path.basename(workspace).startsWith('superdoc-codex-test-')) {
      rmSync(workspace, { recursive: true, force: true, maxRetries: 3 });
    }
  }
}, 180_000);
