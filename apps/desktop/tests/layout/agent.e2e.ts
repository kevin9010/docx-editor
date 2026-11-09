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

async function mockBaseUrl(page: Page, action: 'replace_text' | 'add_comment' = 'replace_text'): Promise<void> {
  await page.addInitScript(({ original, replacement, action }) => {
    let turn = 0;
    Object.assign(window, { agentRequestCount: 0 });
    Object.assign(window, { __TAURI_INTERNALS__: {
      transformCallback: () => 1, unregisterCallback: () => {},
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      invoke: async (command: string, args?: { request?: { messages?: Array<{ role: string; content: string }> } }) => {
        if (command !== 'chat_completion') return 1;
        Reflect.set(window, 'agentRequestCount', Reflect.get(window, 'agentRequestCount') + 1);
        const inspection = args?.request?.messages?.find((message) => message.role === 'tool');
        const inspected = inspection ? JSON.parse(inspection.content) : null;
        const find = inspected?.scope === 'selection' ? inspected.text : original;
        const tool = turn++ === 0 ? { name: 'superdoc_inspect', arguments: JSON.stringify({ includeText: true }) }
          : turn === 2 ? { name: 'superdoc_perform_action', arguments: JSON.stringify({ action, find, replacement, ...(action === 'add_comment' ? { comment: 'Agent comment for review.' } : {}) }) } : null;
        return { choices: [{ message: tool ? { role: 'assistant', content: null, tool_calls: [{ id: `call-${turn}`, type: 'function', function: tool }] } : { role: 'assistant', content: 'Review this wording suggestion before applying it.' } }] };
      },
    } });
  }, { original, replacement, action });
}

test('defaults to local Codex and gives a usable browser-preview error', async ({ page }) => {
  await open(page);
  await expect(page.locator('#agent-provider')).toHaveValue('codex');
  await page.getByText('Connection settings', { exact: true }).click();
  await expect(page.locator('#codex-model')).toHaveValue('');
  await page.getByRole('button', { name: 'Check connection' }).click();
  await expect(page.getByRole('alert')).toContainText('desktop app');
  await expect(page.getByRole('button', { name: 'Confirm and generate suggestions' })).toBeEnabled();
});

test('edits a suggestion, applies the reviewed wording as a revision, and exports a DOCX', async ({ page }, testInfo) => {
  const reviewedReplacement = 'A User-Reviewed Agreement for Document Excellence';
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mockBaseUrl(page);
  await open(page);
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Confirm and generate suggestions' }).click();
  const suggestion = page.locator('.suggestion');
  await expect(suggestion).toHaveAttribute('data-state', 'pending');
  await expect(suggestion.getByRole('textbox', { name: 'Edit suggestion 1', exact: true })).toHaveValue(replacement);
  const draft = suggestion.getByRole('textbox', { name: 'Edit suggestion 1', exact: true });
  await draft.fill('Temporary wording.');
  await expect(suggestion).toContainText('Edited by you');
  await suggestion.getByRole('button', { name: 'Restore Agent suggestion' }).click();
  await expect(draft).toHaveValue(replacement);
  await draft.fill(original);
  await expect(suggestion.getByRole('button', { name: 'Apply as revision' })).toBeDisabled();
  await draft.fill(reviewedReplacement);
  await expect(page.locator('.header-status')).toContainText('Saved');
  await expect(page.locator('.editor-host')).not.toContainText(replacement);
  await expect(page.locator('.editor-host')).not.toContainText(reviewedReplacement);
  await page.screenshot({ path: testInfo.outputPath('review-editable.png') });
  await page.getByRole('button', { name: 'Apply as revision' }).click();
  await expect(suggestion).toHaveAttribute('data-state', 'applied');
  await expect(page.locator('.header-status')).toContainText('Unsaved');
  await expect(page.locator('.status-bar')).toContainText('Auto-save is paused');
  await expect(page.locator('.editor-host')).toContainText(reviewedReplacement);
  await expect(suggestion.locator('.replacement-text')).toHaveText(reviewedReplacement);
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
  expect(insertions).toContain('A User-Reviewed');
  expect(insertions).not.toContain('A Clear');
  expect(deletions).toContain('Mutual');
  await expect(page.locator('.status-bar')).toContainText('Downloaded');
  await page.locator('input[type="file"]').setInputFiles(savedPath);
  await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
  await expect(page.locator('.editor-host')).toContainText(reviewedReplacement);
  await expect(page.locator('#api-key')).toHaveValue('synthetic-test-key');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain('synthetic-test-key');
  expect(errors).toEqual([]);
});

test('selecting any writing action waits for explicit confirmation before contacting Base URL', async ({ page }) => {
  await mockBaseUrl(page);
  await open(page);
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-test-key');
  for (const name of ['Revise', 'Polish', 'Proofread', 'Academic', 'Translate', 'Summarize', 'Custom']) {
    const button = page.getByRole('button', { name, exact: true });
    await button.click();
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByRole('region', { name: 'Review task' })).toContainText(name);
    await expect(page.locator('.progress-spinner')).toHaveCount(0);
    expect(await page.evaluate(() => Reflect.get(window, 'agentRequestCount'))).toBe(0);
  }
  await page.getByRole('button', { name: 'Academic', exact: true }).click();
  await page.getByRole('button', { name: 'Confirm and generate suggestions' }).click();
  await expect(page.getByRole('textbox', { name: 'Edit suggestion 1', exact: true })).toHaveValue(replacement);
  expect(await page.evaluate(() => Reflect.get(window, 'agentRequestCount'))).toBeGreaterThan(0);
});

test('edits a proposed comment before adding and exporting it', async ({ page }, testInfo) => {
  await mockBaseUrl(page, 'add_comment');
  await open(page);
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Confirm and generate suggestions' }).click();
  const draft = page.getByRole('textbox', { name: 'Edit comment 1', exact: true });
  await expect(draft).toHaveValue('Agent comment for review.');
  await draft.fill('   ');
  await expect(page.getByRole('button', { name: 'Add comment', exact: true })).toBeDisabled();
  await draft.fill('My reviewed comment.');
  await expect(page.locator('.header-status')).toContainText('Saved');
  await expect(page.locator('.editor-host')).not.toContainText('My reviewed comment.');
  await page.getByRole('button', { name: 'Add comment', exact: true }).click();
  await expect(page.locator('.suggestion')).toHaveAttribute('data-state', 'applied');
  await expect(page.locator('.suggestion .replacement-text')).toHaveText('My reviewed comment.');
  await page.evaluate(() => { Reflect.deleteProperty(window, '__TAURI_INTERNALS__'); });
  const downloaded = page.waitForEvent('download');
  await page.getByRole('button', { name: 'File', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Save Ctrl+S', exact: true }).click();
  const savedPath = testInfo.outputPath('reviewed-comment.docx');
  await (await downloaded).saveAs(savedPath);
  const archive = await JSZip.loadAsync(await readFile(savedPath));
  const comments = await archive.file('word/comments.xml')!.async('string');
  expect(comments).toContain('My reviewed comment.');
  expect(comments).not.toContain('Agent comment for review.');
});

test('dismissing an edited draft leaves the document unchanged', async ({ page }) => {
  await mockBaseUrl(page);
  await open(page);
  await page.locator('#agent-provider').selectOption('baseUrl');
  await page.getByText('Connection settings', { exact: true }).click();
  await page.locator('#api-key').fill('synthetic-test-key');
  await page.getByRole('button', { name: 'Confirm and generate suggestions' }).click();
  await page.getByRole('textbox', { name: 'Edit suggestion 1', exact: true }).fill('An unapplied draft.');
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(page.locator('.suggestion')).toHaveAttribute('data-state', 'dismissed');
  await expect(page.locator('.editor-host')).not.toContainText('An unapplied draft.');
  await expect(page.locator('.header-status')).toContainText('Saved');
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
  await page.getByRole('button', { name: 'Confirm and generate suggestions' }).click();
  await expect(page.locator('.suggestion .original-text')).toHaveText(selected);
  await page.getByRole('button', { name: 'Apply as revision' }).click();
  await expect(page.locator('.suggestion')).toHaveAttribute('data-state', 'applied');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.editor-host')).toContainText(replacement);
});
