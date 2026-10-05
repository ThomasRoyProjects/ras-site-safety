import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          ADMIN_INITIAL_PASSWORD: 'Test-Admin-Password-2026',
          FRAMER_INITIAL_PASSWORD: 'Test-Framer-Password-2026'
        }
      },
      wrangler: { configPath: './wrangler.jsonc' }
    })
  ],
  test: {
    include: ['tests/**/*.test.js'],
    // Tests target the production's single stable Durable Object name and
    // reset its SQL storage in hooks, so test bodies must not overlap.
    sequence: { concurrent: false },
    hookTimeout: 30_000,
    testTimeout: 30_000
  }
});
