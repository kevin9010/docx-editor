import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sampleDocument = fileURLToPath(new URL('../../../../assets/sample-contract.docx', import.meta.url));

async function expectToolbarInsideEditor(page: Page): Promise<void> {
  // Wait for the toolbar's throttled ResizeObserver, then inspect painted bounds.
  // A viewport-sized toolbar can fit its root while its buttons cover the Agent.
  await expect
    .poll(() =>
      page.evaluate(() => {
        const host = document.querySelector<HTMLElement>('.editor-toolbar')!;
        const agent = document.querySelector<HTMLElement>('.agent-pane')!;
        const hostRect = host.getBoundingClientRect();
        const agentRect = agent.getBoundingClientRect();
        const items = [...host.querySelectorAll<HTMLElement>('[data-sd-part="toolbar-item"]')];
        return (
          items.length > 0 &&
          host.scrollWidth <= host.clientWidth + 1 &&
          hostRect.bottom + 8 <= agentRect.top &&
          items.every((item) => {
            const rect = item.getBoundingClientRect();
            return rect.width === 0 || (rect.left >= hostRect.left - 1 && rect.right <= hostRect.right + 1);
          })
        );
      }),
    )
    .toBe(true);
}

for (const width of [1440, 1280, 1100, 960]) {
  test(`toolbar stays above the floating Agent at ${width}px`, async ({ page }, testInfo) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await page.locator('input[type="file"]').setInputFiles(sampleDocument);
    await expect(page.locator('.status-bar')).toContainText('Ready', { timeout: 30_000 });
    await expectToolbarInsideEditor(page);

    // Real pointer clicks catch the original bug: a toolbar control intercepted
    // the Hide Agent button even though both elements were visible.
    await page.getByRole('button', { name: 'Hide Agent', exact: true }).click();
    await expect(page.locator('.agent-pane')).toHaveClass(/collapsed/);
    await expectToolbarInsideEditor(page);
    await page.getByRole('button', { name: 'Show Agent', exact: true }).click();
    await expect(page.locator('.agent-pane')).not.toHaveClass(/collapsed/);
    await expectToolbarInsideEditor(page);

    await page.setViewportSize({ width: 960, height: 900 });
    await expectToolbarInsideEditor(page);
    const overflowMenu = page.locator('.sd-toolbar-overflow-menu');
    await expect(async () => {
      if (!(await overflowMenu.isVisible())) await page.locator('.editor-toolbar [aria-label="Overflow items"]').click();
      await expect(overflowMenu).toBeVisible();
    }).toPass();
    expect(await overflowMenu.locator('[data-sd-part="toolbar-item"]').count()).toBeGreaterThan(0);
    await page.keyboard.press('Escape');
    await expect(overflowMenu).toBeHidden();
    await page.locator('#agent-prompt').fill('Review this document.');
    await expect(page.locator('#agent-prompt')).toHaveValue('Review this document.');
    expect(errors).toEqual([]);
    await page.screenshot({ path: testInfo.outputPath('toolbar.png') });
  });
}
