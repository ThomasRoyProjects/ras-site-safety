import { test, expect } from '@playwright/test';
import { PASSWORDS, login, logout } from './helpers.js';

async function expectNavigationToFit(page) {
  const navigation = page.getByRole('navigation', { name: 'Workspace navigation' });
  const tabs = navigation.getByRole('button');
  await expect(tabs).toHaveCount(4);
  await navigation.scrollIntoViewIfNeeded();
  for (const tab of await tabs.all()) {
    await expect(tab).toBeVisible();
    await expect(tab).toBeInViewport();
  }

  const tabStripWidths = await navigation.locator('.workspace-nav-inner').evaluate((element) => ({
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth
  }));
  expect(tabStripWidths.scrollWidth).toBeLessThanOrEqual(tabStripWidths.clientWidth);

  const pageWidths = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    viewportWidth: window.innerWidth
  }));
  expect(pageWidths.scrollWidth).toBeLessThanOrEqual(pageWidths.viewportWidth);
}

test('each role layout shows every tab without horizontal scrolling', async ({ page }) => {
  await login(page, 'framer@example.test', PASSWORDS.framer);
  await expectNavigationToFit(page);

  await logout(page);
  await login(page, 'admin@example.test', PASSWORDS.admin);
  await expectNavigationToFit(page);
});
