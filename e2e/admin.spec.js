import { test, expect } from '@playwright/test';
import { PASSWORDS, login, createSubmissionForAdmin } from './helpers.js';

test('admin can filter submissions by site and find an empty date range', async ({ page }) => {
  await login(page, 'admin@example.test', PASSWORDS.admin);
  await expect(page.getByRole('heading', { name: 'Submissions by site' })).toBeVisible();

  await page.getByRole('button', { name: 'Submissions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Find submissions' })).toBeVisible();
  const history = page.locator('details.admin-history-details');
  await expect(history).toBeVisible();
  await history.locator('summary').click();
  const allRows = page.locator('tbody tr');
  const allCount = await allRows.count();
  expect(allCount).toBeGreaterThan(0);

  await page.locator('#admin-site-filter').selectOption({ label: 'Maple Site' });
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByText('Showing: Maple Site', { exact: false })).toBeVisible();
  await history.locator('summary').click();

  const filteredRows = page.locator('tbody tr');
  await expect(filteredRows).not.toHaveCount(0);
  for (const filteredRow of await filteredRows.all()) {
    await expect(filteredRow.getByText('Maple Site', { exact: true })).toBeVisible();
  }

  await page.locator('#admin-date-from').fill('2099-01-01');
  await page.locator('#admin-date-to').fill('2099-01-02');
  await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'No submissions found' })).toBeVisible();
});

test('admin can cancel and then confirm deleting a submission', async ({ page }, testInfo) => {
  const row = await createSubmissionForAdmin(page, testInfo, 'admin-delete');
  const date = row.getByText(/2026-/);
  await row.getByRole('button', { name: /View submission/ }).click();
  const drawer = page.getByRole('dialog', { name: 'Submission details' });
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Delete submission', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await drawer.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(drawer.getByRole('button', { name: 'Delete submission', exact: true })).toBeVisible();
  await expect(date).toBeVisible();

  await drawer.getByRole('button', { name: 'Delete submission', exact: true }).click();
  await drawer.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Submission deleted.');
  await expect(date).toHaveCount(0);
});
