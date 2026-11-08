import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));
async function changeLanguage(page: Page, language: string) {
  await page.getByRole('button', { name: /^(语言|Language)$/ }).click();
  await page.getByRole('menuitemradio', { name: language, exact: true }).click();
}

test('defaults to Chinese and uses a compact file menu with keyboard access', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '文档助手' })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  await expect(page.locator('.app-header')).toHaveCount(0);
  expect((await page.locator('.app-menu').boundingBox())!.height).toBeLessThanOrEqual(32);
  await expect(page.getByRole('menuitem', { name: /打开/ })).toHaveCount(0);
  await page.getByRole('button', { name: '文件', exact: true }).focus();
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: '打开 Ctrl+O', exact: true })).toBeFocused();
  await expect(page.getByRole('menuitem', { name: '保存 Ctrl+S', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '文件', exact: true })).toBeFocused();
  await changeLanguage(page, 'English');
  await expect(page.getByRole('heading', { name: 'Document Agent' })).toBeVisible();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(page.getByRole('button', { name: 'File', exact: true })).toBeVisible();
});

test('switches the editor and Agent language without losing edits, selection or undo history', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.locator('input[type="file"]').setInputFiles(sampleDocument);
  await expect(page.locator('.status-bar')).toContainText('就绪', { timeout: 30_000 });
  await expect(page.getByRole('button', { name: '字体选项', exact: true })).toBeVisible();
  await page.locator('.editor-host .superdoc-text-run').first().dblclick();
  await page.keyboard.type('Open'); // This is document content, not interface copy.
  await expect(page.locator('.header-status')).toContainText('未保存');
  const before = await page.evaluate(async () => {
    const owner = [...document.querySelectorAll('*')].map(node => Reflect.get(node, '__vue_app__')?.config.globalProperties.$superdoc).find(Boolean);
    Reflect.set(window, 'localeTestOwner', owner);
    return { text: await owner.activeEditor.doc.getText({}), revision: (await owner.activeEditor.doc.info({})).revision };
  });
  await page.locator('.editor-host .superdoc-text-run').first().dblclick();
  await expect(page.locator('.selection-preview')).toBeVisible();
  const selected = await page.locator('.selection-preview').innerText();
  await changeLanguage(page, 'English');
  await expect(page.getByRole('button', { name: 'Font family options', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled();
  await expect(page.locator('.selection-preview')).toHaveText(selected);
  await expect(page.locator('.header-status')).toContainText('Unsaved');
  const after = await page.evaluate(async () => {
    const owner = [...document.querySelectorAll('*')].map(node => Reflect.get(node, '__vue_app__')?.config.globalProperties.$superdoc).find(Boolean);
    return { text: await owner.activeEditor.doc.getText({}), revision: (await owner.activeEditor.doc.info({})).revision, same: owner === Reflect.get(window, 'localeTestOwner'), language: owner.ui.getLocale() };
  });
  expect(after).toMatchObject({ ...before, same: true, language: 'en' });
  await changeLanguage(page, '简体中文');
  await expect(page.getByRole('button', { name: '字体选项', exact: true })).toBeVisible();
  await page.keyboard.press('Control+f');
  await expect(page.getByRole('textbox', { name: '查找文字', exact: true })).toBeVisible();
  await page.getByRole('textbox', { name: '查找文字', exact: true }).fill('nonexistent-translation-test');
  await expect(page.locator('.sd-find-replace')).toContainText('无匹配结果');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: testInfo.outputPath('chinese-desktop.png') });
});

test('shows Chinese connection progress and keeps file commands disabled while busy', async ({ page }) => {
  await page.addInitScript(() => Object.assign(window, { __TAURI_INTERNALS__: {
    transformCallback: () => 1, unregisterCallback: () => {},
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    invoke: async (command: string) => {
      if (command === 'codex_start') return new Promise(() => {});
      if (command.startsWith('plugin:menu')) throw new Error('Use the browser menu in this test.');
      return 1;
    },
  } }));
  await page.goto('/');
  await page.getByText('连接设置', { exact: true }).click();
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('正在启动本机 Codex');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '打开 Ctrl+O', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: '停止', exact: true }).click();
  await expect(page.locator('.agent-status-text')).toContainText('连接测试已停止');
  await page.getByRole('button', { name: '文件', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: '打开 Ctrl+O', exact: true })).toBeEnabled();
});
