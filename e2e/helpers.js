import path from 'node:path';
import { expect } from '@playwright/test';

export const PASSWORDS = {
  admin: 'Test-Admin-Password-2026',
  framer: 'Test-Framer-Password-2026'
};

export const PHOTO_PATH = path.resolve(process.cwd(), 'docs/demo-photo.png');

export function workDate(testInfo, label) {
  const month = testInfo.project.name === 'iphone-webkit' ? '12' : '11';
  const text = `${testInfo.project.name}:${label}`;
  const total = [...text].reduce((sum, character) => sum + character.charCodeAt(0), 0);
  const day = String((total % 25) + 1).padStart(2, '0');
  return `2026-${month}-${day}`;
}

export function uniqueStaffEmail(testInfo, label) {
  const project = testInfo.project.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  const suffix = label.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `e2e-${project}-${testInfo.workerIndex}-${suffix}@example.test`;
}

export async function login(page, email, password) {
  await page.goto('/');
  await expect(page.getByLabel('Email address')).toBeVisible();
  await page.getByLabel('Email address').fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Log in', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Log out', exact: true })).toBeVisible();
}

export async function logout(page) {
  await page.getByRole('button', { name: 'Log out', exact: true }).click();
  await expect(page.getByLabel('Email address')).toBeVisible();
}

export async function answerAllSafetyChecks(page) {
  const groups = page.getByRole('radiogroup');
  await expect(groups).toHaveCount(8);
  for (const group of await groups.all()) {
    await group.locator('input[value="1"]').check();
  }
}

export async function createSubmission(page, testInfo, label, site = 'Harbour Site') {
  await page.getByRole('button', { name: 'New submission', exact: true }).click();
  const siteSelect = page.locator('#framer-site');
  await expect(siteSelect).toBeEnabled();
  await siteSelect.selectOption({ label: site });
  await page.locator('#framer-date').fill(workDate(testInfo, label));
  await answerAllSafetyChecks(page);
  await page.getByLabel('Notes').fill(`E2E record ${label}`);
  await page.locator('#framer-photos').setInputFiles(PHOTO_PATH);
  await page.getByRole('button', { name: 'Save safety submission', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Safety submission saved successfully.');
  await expect(siteSelect).toHaveValue('');
  await expect(page.locator('#framer-date')).toHaveValue(/^\d{4}-\d{2}-\d{2}$/);
  await expect(page.getByLabel('Notes')).toHaveValue('');
  await expect(page.locator('#framer-photo-count')).toHaveText('0/5 photos selected.');
}

export async function openFramerSubmission(page, testInfo, label) {
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const history = page.locator('details.history-details');
  await expect(history).toBeVisible();
  await expect(history).not.toHaveAttribute('open', '');
  await history.locator('summary').click();
  const row = page.getByRole('button', { name: `View submission for Harbour Site on ${workDate(testInfo, label)}`, exact: true });
  await expect(row).toBeVisible();
  await row.click();
  const drawer = page.getByRole('dialog', { name: 'Submission details' });
  await expect(drawer).toBeVisible();
  const thumbnail = drawer.getByRole('img', { name: /Site safety photo 1/ });
  await expect(thumbnail).toBeVisible();
  await expect.poll(() => thumbnail.evaluate((image) => image.naturalWidth)).toBeGreaterThan(0);
  return { drawer, row };
}

export async function createSubmissionForAdmin(page, testInfo, label) {
  await login(page, 'framer@example.test', PASSWORDS.framer);
  await createSubmission(page, testInfo, label, 'Maple Site');
  await logout(page);
  await login(page, 'admin@example.test', PASSWORDS.admin);
  await page.getByRole('button', { name: 'Submissions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Submission list' })).toBeVisible();
  const details = page.locator('details.admin-history-details');
  await expect(details).toBeVisible();
  await details.locator('summary').click();
  const row = page.locator('tr').filter({ hasText: workDate(testInfo, label) });
  await expect(row).toHaveCount(1);
  return row;
}
