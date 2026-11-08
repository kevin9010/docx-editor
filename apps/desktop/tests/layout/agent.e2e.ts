import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import JSZip from 'jszip';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('superdoc.desktop.locale', 'en'));
});

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));
const original = 'Mutual Agreement for Document Excellence';
const replacement = 'A Clear Agreement for Document Excellence';

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(sampleDocument);
  await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
}

async function mockBaseUrl(page: Page): Promise<void> {
  await page.addInitScript(({ original, replacement }) => {
    let turn = 0;
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command: string, args?: { request?: { messages?: Array<{ role: string; content: string }> } }) => {
        if (command !== 'chat_completion') return 1;
        const inspection = args?.request?.messages?.find((message) => message.role === 'tool');
        const inspected = inspection ? JSON.parse(inspection.content) : null;
        const find = inspected?.scope === 'selection' ? inspected.text : original;
        const tool = turn++ === 0 ? { name: 'superdoc_inspect', arguments: JSON.stringify({ includeText: true }) }
          : turn === 2 ? { name: 'superdoc_perform_action', arguments: JSON.stringify({ action: 'replace_text', find, replacement }) } : null;
        return { choices: [{ message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: tool }] } : { role: 'assistant', content: 'Review this wording suggestion before applying it.' } }] };
      },
    } });
  }, { original, replacement });
}

test('defaults to local Codex and gives a usable browser-preview error', async ({ page }) => {
  await open(page);
  await expect(page.locator('#agent-provider')).toHaveValue('codex');
  await page.getByText('Connection settings', { exact: true }).click();
  await expect(page.locator('#codex-model')).toHaveValue('');
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByRole('alert')).toContainText('desktop app');
  await expect(page.getByRole('button', { name: 'Generate suggestions' })).toBeEnabled();
});

test('previews a suggestion, applies it as a revision, and exports a DOCX', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockBaseUrl(page);
  await open(page);
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Generate suggestions' }).click();
  const suggestion = page.locator('.suggestion');
  await expect(suggestion).toHaveAttribute('data-state', 'pending');
  await expect(suggestion.locator('.replacement-text')).toHaveText(replacement);
  await expect(page.locator('.header-status')).toContainText('Saved');
  await expect(page.locator('.editor-host')).not.toContainText(replacement);
  await page.getByRole('button', { name: 'Apply as revision' }).click();
  await expect(suggestion).toHaveAttribute('data-state', 'applied');
  await expect(page.locator('.header-status')).toContainText('Unsaved');
  await expect(page.locator('.status-bar')).toContainText('Auto-save is paused');
  await expect(page.locator('.editor-host')).toContainText(replacement);
  await page.screenshot({ path: testInfo.outputPath('review-applied.png') });
  // Browser download exercises the same SuperDoc DOCX export as native Save.
  await page.evaluate(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save Ctrl+S', exact: true }).click();
  const download = await downloaded;
  const savedPath = testInfo.outputPath('reviewed.docx');
  await download.saveAs(savedPath);
  const archive = await JSZip.loadAsync(await readFile(savedPath));
  const xml = await archive.file('word/document.xml')!.async('string');
  const insertions = (xml.match(/<w:ins\b[\s\S]*?<\/w:ins>/g) ?? []).join('');
  const deletions = (xml.match(/<w:del\b[\s\S]*?<\/w:del>/g) ?? []).join('');
  expect(insertions).toContain('A Clear');
  expect(deletions).toContain('Mutual');
  await expect(page.locator('.status-bar')).toContainText('Downloaded');
  await page.locator('input[type="file"]').setInputFiles(savedPath);
  await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
  await expect(page.locator('.editor-host')).toContainText(replacement);
  await expect(page.locator('#api-key')).toHaveValue('synthetic-test-key');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-test-key');
  expect(errors).toEqual([]);
});

test('keeps a selected passage when focus moves into the Agent', async ({ page }) => {
  await open(page);
  await page.locator('.editor-host .superdoc-text-run').first().dblclick();
  await expect(page.locator('.selection-preview')).toBeVisible();
  const text = await page.locator('.selection-preview').innerText();
  expect(text.trim().length).toBeGreaterThan(0);
  await page.locator('#agent-prompt').fill('Keep the meaning.');
  await expect(page.locator('#agent-scope')).toHaveValue('selection');
  await expect(page.locator('.selection-preview')).toHaveText(text);
});

test('applies a selected-passage suggestion through the editor worker', async ({ page }) => {
  await mockBaseUrl(page);
  await open(page);
  await page.locator('.editor-host .superdoc-text-run').first().dblclick();
  await expect(page.locator('.selection-preview')).toBeVisible();
  const selected = await page.locator('.selection-preview').innerText();
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Generate suggestions' }).click();
  await expect(page.locator('.suggestion .original-text')).toHaveText(selected);
  await page.getByRole('button', { name: 'Apply as revision' }).click();
  await expect(page.locator('.suggestion')).toHaveAttribute('data-state', 'applied');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.editor-host')).toContainText(replacement);
});
