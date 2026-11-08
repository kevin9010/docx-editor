import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('superdoc.desktop.locale', 'en'));
});

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));

async function expectToolbarInsideEditor(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const host = document.querySelector<HTMLElement>('.editor-toolbar')!;
    const agent = document.querySelector<HTMLElement>('.agent-pane')!;
    const editor = document.querySelector<HTMLElement>('.editor-pane')!;
    const h = host.getBoundingClientRect(), a = agent.getBoundingClientRect(), e = editor.getBoundingClientRect();
    return host.querySelectorAll('[data-sd-part="toolbar-item"]').length > 0 &&
      h.right <= e.right && h.right < a.left && a.top < h.bottom &&
      ['auto', 'scroll'].includes(getComputedStyle(host).overflowX) &&
      document.elementFromPoint(a.left + a.width / 2, h.top + 24)?.closest('.agent-pane') === agent;
  })).toBe(true);
}

for (const width of [1440, 1280, 1100, 960]) {
  test(`toolbar scrolls beside the full-height Agent at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(sampleDocument);
    await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
    await expectToolbarInsideEditor(page);
    await page.getByRole('button', { name: 'Hide Agent', exact: true }).click();
    await expect(page.locator('.agent-pane')).toHaveClass(/collapsed/);
    await expectToolbarInsideEditor(page);
    await page.getByRole('button', { name: 'Show Agent', exact: true }).click();
    await expect(page.locator('.agent-pane')).not.toHaveClass(/collapsed/);
    await expectToolbarInsideEditor(page);

    await page.setViewportSize({ width: 960, height: 900 });
    await expectToolbarInsideEditor(page);
    const toolbar = page.locator('.editor-toolbar');
    const scrollLeft = () => toolbar.evaluate(node => node.scrollLeft);
    await expect.poll(() => toolbar.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await page.getByRole('button', { name: 'Scroll toolbar right' }).click();
    await expect.poll(scrollLeft).toBeGreaterThan(100);
    await page.getByRole('button', { name: 'Scroll toolbar left' }).click();
    await expect.poll(scrollLeft).toBeLessThan(2);
    await toolbar.hover();
    await page.mouse.wheel(0, 300);
    await expect.poll(scrollLeft).toBeGreaterThan(100);
    // Controls at both ends remain operable, and teleported menus escape the
    // scrolling viewport instead of being clipped to the toolbar's height.
    await toolbar.evaluate(node => { node.scrollLeft = node.scrollWidth; });
    const lastItem = toolbar.locator('[data-sd-part="toolbar-item"]').last();
    await expect(lastItem).toBeInViewport();
    await toolbar.evaluate(node => { node.scrollLeft = 0; });
    await page.getByRole('button', { name: 'Font family options', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Font family', exact: true })).toBeVisible();
    await page.getByRole('option', { name: 'Font family - Arial', exact: true }).click();
    await expect(page.getByRole('listbox', { name: 'Font family', exact: true })).toBeHidden();
    await page.locator('#agent-prompt').fill('Review this document.');
    await expect(page.locator('#agent-prompt')).toHaveValue('Review this document.');
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('toolbar.png') });
  });
}
