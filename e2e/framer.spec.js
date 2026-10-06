import { test, expect } from '@playwright/test';
import { PASSWORDS, login, createSubmission, openFramerSubmission } from './helpers.js';

test('Framer can save a complete submission and review its photo', async ({ page }, testInfo) => {
  const label = 'framer-save';
  await login(page, 'framer@example.test', PASSWORDS.framer);
  await createSubmission(page, testInfo, label);

  const { drawer, row } = await openFramerSubmission(page, testInfo, label);
  await expect(drawer.getByRole('button', { name: 'Delete submission', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(row).toBeFocused();
});

test('validation summary is visible without stealing focus during field edits', async ({ page }) => {
  await login(page, 'framer@example.test', PASSWORDS.framer);
  await page.getByRole('button', { name: 'New submission', exact: true }).click();
  const site = page.locator('#framer-site');
  await expect(site).toBeEnabled();
  await page.getByRole('button', { name: 'Save safety submission', exact: true }).click();

  const summary = page.getByRole('alert').filter({ hasText: 'Review the following before submitting:' });
  await expect(summary).toBeFocused();
  const box = await summary.boundingBox();
  const viewport = page.viewportSize();
  expect(box).not.toBeNull();
  const viewportTolerance = 1;
  expect(box.y).toBeGreaterThanOrEqual(-viewportTolerance);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height + viewportTolerance);
  await expect(site).toHaveAttribute('aria-invalid', 'true');

  await site.focus();
  await site.selectOption({ label: 'Harbour Site' });
  await expect(site).not.toHaveAttribute('aria-invalid', 'true');
  await expect(site).toBeFocused();
});
