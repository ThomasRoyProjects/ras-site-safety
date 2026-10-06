import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  use: { baseURL: 'http://127.0.0.1:8788' },
  projects: [
    {
      name: 'desktop-chromium',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 900 } }
    },
    {
      name: 'iphone-webkit',
      use: { ...devices['iPhone 13'], browserName: 'webkit' }
    }
  ],
  webServer: {
    command: 'npm run build && node -e "require(\'fs\').rmSync(\'.wrangler/e2e\',{recursive:true,force:true})" && wrangler dev --ip 127.0.0.1 --port 8788 --persist-to .wrangler/e2e --var ADMIN_INITIAL_PASSWORD:Test-Admin-Password-2026 --var FRAMER_INITIAL_PASSWORD:Test-Framer-Password-2026',
    url: 'http://127.0.0.1:8788/api/health',
    reuseExistingServer: false,
    timeout: 120_000
  }
});
