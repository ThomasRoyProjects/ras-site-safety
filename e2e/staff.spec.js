import { test, expect } from '@playwright/test';
import { PASSWORDS, login, logout, uniqueStaffEmail } from './helpers.js';

test('admin creates a Framer who changes the temporary password before entering the workspace', async ({ page }, testInfo) => {
  const email = uniqueStaffEmail(testInfo, 'lifecycle');
  const temporaryPassword = 'Temporary-E2E-Password-2026';
  const newPassword = 'Changed-E2E-Password-2026';

  await login(page, 'admin@example.test', PASSWORDS.admin);
  await page.getByRole('button', { name: 'Staff', exact: true }).click();
  await page.locator('details.staff-create-details').locator('summary').click();
  await page.getByLabel('Name', { exact: true }).fill('E2E Temporary Framer');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Temporary password', { exact: true }).fill(temporaryPassword);
  await page.getByLabel('Confirm temporary password', { exact: true }).fill(temporaryPassword);
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Account created for E2E Temporary Framer');

  await logout(page);
  await login(page, email, temporaryPassword);
  await expect(page.getByRole('heading', { name: 'Set your new password' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toHaveCount(0);

  await page.reload();
  await expect(page.getByRole('heading', { name: 'Set your new password' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Workspace navigation' })).toHaveCount(0);

  await page.getByLabel('Current password', { exact: true }).fill(temporaryPassword);
  await page.getByLabel('New password', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirm new password', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Save new password', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();

  await login(page, email, newPassword);
  await expect(page.getByRole('heading', { name: 'Framer overview' })).toBeVisible();
});

test('Framer and Admin receive only their role-specific navigation tabs', async ({ page }) => {
  await login(page, 'framer@example.test', PASSWORDS.framer);
  const framerNav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(framerNav.getByRole('button')).toHaveCount(4);
  await expect(framerNav.getByRole('button', { name: 'Staff', exact: true })).toHaveCount(0);
  await expect(framerNav.getByRole('button', { name: 'Submissions', exact: true })).toHaveCount(0);

  await logout(page);
  await login(page, 'admin@example.test', PASSWORDS.admin);
  const adminNav = page.getByRole('navigation', { name: 'Workspace navigation' });
  await expect(adminNav.getByRole('button', { name: 'Overview', exact: true })).toBeVisible();
  await expect(adminNav.getByRole('button', { name: 'Submissions', exact: true })).toBeVisible();
  await expect(adminNav.getByRole('button', { name: 'Staff', exact: true })).toBeVisible();
  await expect(adminNav.getByRole('button', { name: 'Account', exact: true })).toBeVisible();
});
