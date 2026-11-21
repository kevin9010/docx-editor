import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));
const original = 'Mutual Agreement for Document Excellence';
const replacement = 'A Clear Agreement for Document Excellence';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(sampleDocument);
  await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
  await page.locator('#agent-provider').selectOption('claude');
  await page.getByText('Connection settings', { exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('superdoc.desktop.locale', 'en'));
});

async function mockClaude(page: Page, slow = false): Promise<void> {
  await page.addInitScript(({ original, replacement, slow }) => {
    const calls: Array<{ command: string; request?: { prompt?: string; model?: string; requestId: string }; requestId?: string }> = [];
    let pending: { onmessage: (event: unknown) => void } | null = null;
    Object.assign(window, { claudeTest: { calls, finish: () => pending?.onmessage({ type: 'result', output: { summary: 'Late result', suggestions: [] } }) } });
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command: string, args: { request?: { prompt?: string; model?: string; requestId: string }; requestId?: string; onEvent: { onmessage: (event: unknown) => void } }) => {
        if (!command.startsWith('claude_')) return 1;
        calls.push({ command, request: args.request, requestId: args.requestId });
        if (command === 'claude_start' && !args.request?.prompt) args.onEvent.onmessage({ type: 'checked', signedIn: true, executable: 'C:/Users/test/.local/bin/claude.exe' });
        else if (command === 'claude_start' && slow) pending = args.onEvent;
        else if (command === 'claude_start') args.onEvent.onmessage({ type: 'result', output: { summary: 'Review the wording suggestion.', suggestions: [{ action: 'replace_text', find: original, text: replacement }] } });
      },
    } });
  }, { original, replacement, slow });
}

test('checks Claude login without sending a document and generates only after confirmation', async ({ page }, testInfo) => {
  await mockClaude(page);
  await open(page);
  await expect(page.locator('#api-key')).toHaveCount(0);
  await expect(page.locator('#claude-model')).toHaveValue('');
  await page.getByRole('button', { name: 'Check connection', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('installation and login checked');
  const checked = await page.evaluate(() => Reflect.get(window, 'claudeTest').calls);
  expect(checked).toHaveLength(1);
  expect(checked[0].request).not.toHaveProperty('prompt');
  await page.getByRole('button', { name: 'Academic', exact: true }).click();
  await page.locator('#claude-model').fill('opus');
  expect(await page.evaluate(() => Reflect.get(window, 'claudeTest').calls.length)).toBe(1);
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  const draft = page.getByRole('textbox', { name: 'Edit suggestion 1', exact: true });
  await expect(draft).toHaveValue(replacement);
  await expect(page.locator('.header-status')).toContainText('Saved');
  await expect(page.locator('.editor-host')).not.toContainText(replacement);
  const requests = await page.evaluate(() => Reflect.get(window, 'claudeTest').calls);
  expect(requests).toHaveLength(2);
  expect(requests[1].request.model).toBe('opus');
  expect(requests[1].request.prompt).toContain(original);
  expect(requests[1].request).not.toHaveProperty('apiKey');
  await draft.fill('A User-Reviewed Agreement for Document Excellence');
  await page.getByRole('button', { name: 'Apply as revision', exact: true }).click();
  await expect(page.locator('.suggestion')).toHaveAttribute('data-state', 'applied');
  await expect(page.locator('.header-status')).toContainText('Unsaved');
  await expect(page.locator('.editor-host')).toContainText('A User-Reviewed Agreement for Document Excellence');
  await page.screenshot({ path: testInfo.outputPath('claude-cli-reviewed.png') });
});

test('stops the matching Claude process and ignores a late result', async ({ page }) => {
  await mockClaude(page, true);
  await open(page);
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Starting the installed Claude Code');
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Stopped');
  const calls = await page.evaluate(() => Reflect.get(window, 'claudeTest').calls);
  expect(calls).toHaveLength(2);
  expect(calls[1]).toMatchObject({ command: 'claude_cancel', requestId: calls[0].request.requestId });
  await page.evaluate(() => Reflect.get(window, 'claudeTest').finish());
  await expect(page.locator('.agent-summary')).not.toContainText('Late result');
  await expect(page.locator('.suggestion')).toHaveCount(0);
  await expect(page.locator('.header-status')).toContainText('Saved');
});

test('preserves independent CLI model preferences and localizes the Claude option', async ({ page }) => {
  await mockClaude(page);
  await open(page);
  await page.locator('#claude-model').fill('sonnet');
  await page.getByRole('button', { name: 'Confirm and generate suggestions', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('Ready');
  await page.locator('#agent-provider').selectOption('codex');
  await expect(page.locator('#codex-model')).toHaveValue('');
  await page.locator('#agent-provider').selectOption('claude');
  await expect(page.locator('#claude-model')).toHaveValue('sonnet');
  await page.getByRole('button', { name: 'Language', exact: true }).click();
  await page.getByRole('menuitemradio', { name: '简体中文', exact: true }).click();
  await expect(page.locator('#agent-provider option:checked')).toHaveText('本机 Claude Code CLI');
  await expect(page.locator('.connection-settings')).toContainText('本应用不保存密钥');
});
