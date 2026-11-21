import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));
const discoveredModels = ['discovered-codex-fast', 'discovered-codex-review'];

async function loadDocument(page: Page): Promise<void> {
  await page.locator('input[type="file"]').setInputFiles(sampleDocument);
  await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
  await page.getByText('Connection settings', { exact: true }).click();
}

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await loadDocument(page);
}

async function mockCliModels(page: Page): Promise<void> {
  await page.addInitScript(({ discoveredModels }) => {
    type Rpc = { id?: number; method?: string; params?: Record<string, unknown> };
    type ClaudeRequest = { requestId: string; prompt?: string; model?: string };
    type EventChannel = { onmessage: (event: unknown) => void };
    const rpc: Rpc[] = [];
    const claudeRequests: ClaudeRequest[] = [];
    let channel: EventChannel;
    let starts = 0;
    let stops = 0;
    let threadId = '';
    let turnId = '';
    Object.assign(window, {
      modelTest: {
        rpc, claudeRequests,
        get starts() { return starts; },
        get stops() { return stops; },
        finishCodex: () => channel.onmessage({ method: 'turn/completed', params: { threadId, turn: { id: turnId, status: 'completed' } } }),
      },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        invoke: async (command: string, args: { onEvent: EventChannel; message: Rpc; request: ClaudeRequest }) => {
          if (command === 'codex_start') {
            starts++;
            channel = args.onEvent;
            return { sessionId: `model-session-${starts}`, executable: 'C:/synthetic/codex.exe' };
          }
          if (command === 'codex_stop') { stops++; return; }
          if (command === 'claude_start') {
            claudeRequests.push(structuredClone(args.request));
            args.onEvent.onmessage(args.request.prompt
              ? { type: 'result', output: { summary: 'Synthetic model review complete.', suggestions: [] } }
              : { type: 'checked', signedIn: true, executable: 'C:/synthetic/claude.exe' });
            return;
          }
          if (command !== 'codex_send') return 1;
          const message = structuredClone(args.message);
          rpc.push(message);
          if (message.id === undefined || !message.method) return;
          let result: unknown = {};
          if (message.method === 'account/read') result = { account: {}, requiresOpenaiAuth: true };
          if (message.method === 'model/list') result = {
            data: discoveredModels.map((model, index) => ({ model, displayName: `Discovered model ${index + 1}`, isDefault: index === 0 })),
            nextCursor: null,
          };
          if (message.method === 'thread/start') {
            threadId = `model-thread-${rpc.filter(call => call.method === 'thread/start').length}`;
            result = { thread: { id: threadId }, model: message.params?.model ?? 'synthetic-cli-default' };
          }
          if (message.method === 'turn/start') {
            turnId = `model-turn-${rpc.filter(call => call.method === 'turn/start').length}`;
            result = { turn: { id: turnId } };
          }
          channel.onmessage({ id: message.id, result });
          if (message.method === 'turn/start') channel.onmessage({ method: 'turn/started', params: { threadId, turn: { id: turnId } } });
        },
      },
    });
  }, { discoveredModels });
}

async function generateCodex(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Codex accepted');
  await page.evaluate(() => Reflect.get(window, 'modelTest').finishCodex());
  await expect(page.locator('.agent-status-text')).toContainText('Ready for your review');
  await expect(page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true })).toBeEnabled();
}

async function preferences(page: Page): Promise<{ codex: string | null; claude: string | null }> {
  return page.evaluate(() => ({
    codex: localStorage.getItem('superdoc.desktop.codexModel'),
    claude: localStorage.getItem('superdoc.desktop.claudeModel'),
  }));
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('superdoc.desktop.locale', 'en'));
});

test('Codex discovery suggests model IDs without replacing a custom selection or restricting unlisted IDs', async ({ page }) => {
  const saved = 'enterprise/codex-saved';
  const custom = 'private-provider/codex-unlisted-2026-11';
  await page.addInitScript(saved => localStorage.setItem('superdoc.desktop.codexModel', `  ${saved}  `), saved);
  await mockCliModels(page);
  await open(page);
  const input = page.locator('input#codex-model');
  await expect(input).toHaveAttribute('list', 'codex-model-options');
  await expect(input).toHaveValue(saved);
  await expect(page.locator('.run-confirmation')).toContainText(saved);
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Codex login and model list checked');
  expect(await page.locator('#codex-model-options option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(discoveredModels);
  await expect(input).toHaveValue(saved);
  await expect(page.locator('.run-confirmation')).toContainText(saved);
  expect(await page.evaluate(() => Reflect.get(window, 'modelTest').rpc.filter((call: { method?: string }) => call.method === 'thread/start'))).toHaveLength(0);

  await input.fill(`  ${custom}  `);
  await expect(page.locator(`#codex-model-options option[value="${custom}"]`)).toHaveCount(0);
  await expect(page.locator('.run-confirmation p').first()).toHaveText(`Polish · Whole document · Local Codex CLI · ${custom}`);
  await expect.poll(() => preferences(page)).toMatchObject({ codex: custom });
  await generateCodex(page);
  const calls = await page.evaluate(() => Reflect.get(window, 'modelTest').rpc);
  expect(calls.filter((call: { method?: string }) => call.method === 'thread/start')).toMatchObject([{ params: { model: custom } }]);
  expect(calls.filter((call: { method?: string }) => call.method === 'model/list')).toHaveLength(1);
  expect(await page.evaluate(() => Reflect.get(window, 'modelTest').starts)).toBe(1);
});

test('a warm Codex client uses each new custom model and reset omits the model override', async ({ page }) => {
  await mockCliModels(page);
  await open(page);
  const input = page.locator('#codex-model');
  await expect(input).toHaveValue('');
  await expect(page.locator('.run-confirmation')).toContainText('CLI default');
  await input.fill('  first-provider/codex-custom  ');
  await generateCodex(page);
  await input.fill('  second-provider:codex-preview  ');
  await expect(page.locator('.run-confirmation p').first()).toHaveText('Polish · Whole document · Local Codex CLI · second-provider:codex-preview');
  await generateCodex(page);

  await page.getByRole('button', { name: 'Use CLI default', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.run-confirmation p').first()).toHaveText('Polish · Whole document · Local Codex CLI · CLI default');
  await expect.poll(() => preferences(page)).toMatchObject({ codex: '' });
  await generateCodex(page);
  const calls = await page.evaluate(() => Reflect.get(window, 'modelTest').rpc);
  const threads = calls.filter((call: { method?: string }) => call.method === 'thread/start');
  expect(threads).toHaveLength(3);
  expect(threads[0].params.model).toBe('first-provider/codex-custom');
  expect(threads[1].params.model).toBe('second-provider:codex-preview');
  expect(threads[2].params).not.toHaveProperty('model');
  expect(calls.filter((call: { method?: string }) => call.method === 'model/list')).toHaveLength(0);
  expect(calls.filter((call: { method?: string }) => call.method === 'thread/unsubscribe')).toHaveLength(3);
  expect(await page.evaluate(() => ({ starts: Reflect.get(window, 'modelTest').starts, stops: Reflect.get(window, 'modelTest').stops }))).toEqual({ starts: 1, stops: 0 });
});

test('API providers do not label an empty model as the CLI default', async ({ page }) => {
  await mockCliModels(page);
  await open(page);
  await page.locator('#agent-provider').selectOption('openai');
  await page.locator('#model').fill('');
  await expect(page.locator('.run-confirmation')).not.toContainText('CLI default');
  await expect(page.locator('.run-confirmation')).toContainText('OpenAI-compatible API');
});

test('Claude custom IDs and Codex preferences persist independently across provider switches and reload', async ({ page }) => {
  const codex = 'private/codex-persisted';
  const claude = 'enterprise/claude-custom-2026-11';
  await mockCliModels(page);
  await open(page);
  await page.locator('#codex-model').fill(`  ${codex}  `);
  await page.locator('#agent-provider').selectOption('claude');
  const input = page.locator('input#claude-model');
  await expect(input).toHaveAttribute('list', 'claude-model-options');
  await expect(input).toHaveValue('');
  await expect(page.locator('.run-confirmation')).toContainText('CLI default');
  expect(await page.locator('#claude-model-options option').evaluateAll(options => options.map(option => (option as HTMLOptionElement).value))).toEqual(expect.arrayContaining(['opus', 'sonnet', 'haiku']));
  await input.fill(`  ${claude}  `);
  await expect(page.locator(`#claude-model-options option[value="${claude}"]`)).toHaveCount(0);
  await expect(page.locator('.run-confirmation p').first()).toHaveText(`Polish · Whole document · Local Claude Code CLI · ${claude}`);
  await expect.poll(() => preferences(page)).toEqual({ codex, claude });
  await page.locator('#agent-provider').selectOption('codex');
  await expect(page.locator('#codex-model')).toHaveValue(`  ${codex}  `);
  await expect(page.locator('.run-confirmation')).toContainText(codex);
  await page.locator('#agent-provider').selectOption('claude');
  await expect(input).toHaveValue(`  ${claude}  `);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('superdoc.desktop.provider'))).toBe('claude');

  await page.reload();
  await loadDocument(page);
  await expect(page.locator('#agent-provider')).toHaveValue('claude');
  await expect(input).toHaveValue(claude);
  await expect(page.locator('.run-confirmation p').first()).toHaveText(`Polish · Whole document · Local Claude Code CLI · ${claude}`);
  await input.fill(`  ${claude}  `);
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Ready for your review');
  const requests = await page.evaluate(() => Reflect.get(window, 'modelTest').claudeRequests);
  expect(requests).toHaveLength(1);
  expect(requests[0].model).toBe(claude);
  expect(requests[0].prompt).toContain('Mutual Agreement for Document Excellence');
  expect(requests[0]).not.toHaveProperty('apiKey');
  await page.locator('#agent-provider').selectOption('codex');
  await expect(page.locator('#codex-model')).toHaveValue(codex);
  await page.locator('#agent-provider').selectOption('claude');
  await page.getByRole('button', { name: 'Use CLI default', exact: true }).click();
  await expect(input).toHaveValue('');
  await expect(page.locator('.run-confirmation')).toContainText('CLI default');
  await expect.poll(() => preferences(page)).toEqual({ codex, claude: '' });
  expect(await page.evaluate(() => Reflect.get(window, 'modelTest').starts)).toBe(0);
});
