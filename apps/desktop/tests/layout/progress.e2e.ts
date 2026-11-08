import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('superdoc.desktop.locale', 'en'));
});

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));

async function open(page: Page): Promise<void> {
  await page.setViewportSize({ width: 960, height: 640 });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(sampleDocument);
  await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
}

async function mockSlowCodex(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let channel: { onmessage: (message: unknown) => void };
    const methods: string[] = [];
    const replies: number[] = [];
    let stops = 0;
    let starts = 0;
    Object.assign(window, {
      codexTest: { methods, replies, get stops() { return stops; }, get starts() { return starts; }, emit: (message: unknown) => channel.onmessage(message) },
      __TAURI_INTERNALS__: {
        transformCallback: () => 1, unregisterCallback: () => {},
        metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
        invoke: async (command: string, args: { onEvent: typeof channel; message: { id: number; method: string } }) => {
          if (command === 'codex_start') { starts++; channel = args.onEvent; return { sessionId: 'test-session', executable: 'C:/synthetic/codex.exe' }; }
          if (command === 'codex_stop') { stops++; return; }
          if (command !== 'codex_send') return 1;
          const { id, method } = args.message;
          if (!method) { replies.push(id); return; }
          methods.push(method);
          if (method === 'model/list') return; // Deliberately silent connection check.
          const result = method === 'account/read' ? { account: {}, requiresOpenaiAuth: true }
            : method === 'thread/start' ? { thread: { id: 'thread' }, model: 'test-model' }
              : method === 'turn/start' ? { turn: { id: 'turn' } } : {};
          channel.onmessage({ id, result });
          if (method === 'turn/start') channel.onmessage({ method: 'turn/started', params: { threadId: 'thread', turn: { id: 'turn' } } });
        },
      },
    });
  });
}

async function emit(page: Page, method: string, params: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ method, params }) => Reflect.get(window, 'codexTest').emit({ method, params: { threadId: 'thread', turnId: 'turn', ...params } }), { method, params });
}

test('Academic waits for confirmation and keeps slow, streamed and retry progress visible', async ({ page }, testInfo) => {
  await mockSlowCodex(page);
  await open(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.locator('.editor-host .superdoc-text-run').first().dblclick();
  await expect(page.locator('.selection-preview')).toBeVisible();
  await page.setViewportSize({ width: 960, height: 640 });
  await page.clock.install();
  await page.getByRole('button', { name: 'Academic', exact: true }).click();
  await expect(page.locator('.progress-spinner')).toHaveCount(0);
  expect(await page.evaluate(() => Reflect.get(window, 'codexTest').starts)).toBe(0);
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  const status = page.locator('.agent-status-text');
  await expect(status).toContainText('Codex accepted');
  expect(await page.evaluate(() => Reflect.get(window, 'codexTest').methods)).not.toContain('model/list');
  await page.clock.fastForward(21_000);
  await expect(page.locator('.progress-time')).toContainText('Elapsed 21s');
  await expect(page.locator('.progress-wait')).toContainText('No new update');
  await page.locator('.agent-content').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(status).toBeInViewport();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeInViewport();
  await emit(page, 'item/started', { item: { type: 'reasoning' } });
  await expect(status).toContainText('processing');
  await expect(page.locator('.progress-wait')).toHaveCount(0);
  await emit(page, 'item/agentMessage/delta', { itemId: 'message', delta: 'I am reviewing the selected passage.' });
  await expect(page.locator('.progress-preview')).toContainText('reviewing the selected passage');
  await emit(page, 'error', { error: { message: 'Synthetic connection reset' }, willRetry: true });
  await expect(status).toContainText('retrying');
  await page.getByText(/Activity ·/).click();
  await expect(page.locator('.activity-log')).toContainText('test-model');
  await page.screenshot({ path: testInfo.outputPath('academic-progress.png') });
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(status).toContainText('Stopped');
  await expect(page.locator('.agent-summary')).toContainText('reviewing the selected passage');
  await expect(page.getByRole('button', { name: 'Academic', exact: true })).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, 'codexTest').stops)).toBe(1);
});

test('Codex suggestions are editable and only the reviewed text is applied', async ({ page }, testInfo) => {
  await mockSlowCodex(page);
  await open(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  const original = 'Mutual Agreement for Document Excellence';
  await page.getByRole('button', { name: 'Polish', exact: true }).click();
  expect(await page.evaluate(() => Reflect.get(window, 'codexTest').starts)).toBe(0);
  await page.getByRole('button', { name: 'Confirm and generate suggestions' }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Codex accepted');
  await page.evaluate(({ original }) => Reflect.get(window, 'codexTest').emit({
    id: 900,
    method: 'item/tool/call',
    params: { threadId: 'thread', turnId: 'turn', tool: 'superdoc_perform_action', arguments: { action: 'replace_text', find: original, replacement: 'Codex draft wording.' } },
  }), { original });
  await expect.poll(() => page.evaluate(() => Reflect.get(window, 'codexTest').replies.includes(900))).toBe(true);
  await emit(page, 'turn/completed', { turn: { id: 'turn', status: 'completed' } });
  const draft = page.getByRole('textbox', { name: 'Edit suggestion 1', exact: true });
  await expect(draft).toHaveValue('Codex draft wording.');
  await draft.fill('My approved Codex wording.');
  await expect(page.locator('.editor-host')).not.toContainText('My approved Codex wording.');
  await expect(page.locator('.header-status')).toContainText('Saved');
  await page.getByRole('button', { name: 'Apply as revision', exact: true }).click();
  await expect(page.locator('.suggestion')).toHaveAttribute('data-state', 'applied');
  await expect(page.locator('.suggestion .replacement-text')).toHaveText('My approved Codex wording.');
  // Tracked deletions interleave with insertions in the rendered document.
  // Inspect exported Word text to verify the accepted wording independently.
  await page.evaluate(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save Ctrl+S', exact: true }).click();
  const savedPath = testInfo.outputPath('reviewed-codex.docx');
  await (await downloaded).saveAs(savedPath);
  const archive = await JSZip.loadAsync(await readFile(savedPath));
  const xml = await archive.file('word/document.xml')!.async('string');
  const acceptedText = await page.evaluate(xml => [...new DOMParser().parseFromString(xml, 'application/xml').getElementsByTagNameNS('http://schemas.openxmlformats.org/wordprocessingml/2006/main', 't')].map(node => node.textContent).join(''), xml);
  expect(acceptedText).toContain('My approved Codex wording.');
  expect(acceptedText).not.toContain('Codex draft wording.');
  expect(xml).toContain('<w:ins');
  expect(xml).toContain('<w:del');
});

test('connection checks show the current stage and can be stopped without waiting for a timeout', async ({ page }) => {
  await mockSlowCodex(page);
  await open(page);
  await page.clock.install();
  await page.getByText('Connection settings', { exact: true }).click();
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Loading available Codex models');
  await page.clock.fastForward(21_000);
  await expect(page.locator('.progress-wait')).toBeInViewport();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Connection check stopped');
  await expect(page.getByRole('button', { name: 'Check connection' })).toBeEnabled();
  expect(await page.evaluate(() => Reflect.get(window, 'codexTest').stops)).toBe(1);
});

test('slow Base URL requests show progress and cancellation ignores a late response', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __TAURI_INTERNALS__: {
    transformCallback: () => 1, unregisterCallback: () => {},
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke: async (command: string) => command === 'chat_completion' ? new Promise(resolve => {
      Object.assign(window, { finishChat: () => resolve({ choices: [{ message: { content: 'Late response' } }] }) });
    }) : 1,
  } }));
  await open(page);
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-key');
  await page.clock.install();
  await page.getByRole('button', { name: 'Academic', exact: true }).click();
  await expect(page.locator('.progress-spinner')).toHaveCount(0);
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Asking the model');
  await page.clock.fastForward(21_000);
  await expect(page.locator('.progress-wait')).toContainText('model endpoint');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Stopped');
  await page.evaluate(() => Reflect.get(window, 'finishChat')());
  await expect(page.locator('.agent-summary')).not.toContainText('Late response');
  await expect(page.getByRole('button', { name: 'Academic', exact: true })).toBeEnabled();
});
