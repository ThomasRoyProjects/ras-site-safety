import { test, expect } from '@playwright/test';
import { PASSWORDS, login, logout } from './helpers.js';

test('wrong password is rejected, Framer can log in, and logout returns to login', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Email address').fill('framer@example.test');
  await page.getByLabel('Password', { exact: true }).fill('Wrong-password-for-e2e');
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('Invalid email or password');

  await page.getByLabel('Password', { exact: true }).fill(PASSWORDS.framer);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Framer overview' })).toBeVisible();

  await logout(page);
  await expect(page.getByRole('heading', { name: 'Log in to site safety' })).toBeVisible();
});
