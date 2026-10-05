import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    fs: {
      deny: [
        '.env', '.env.*', '*.{crt,pem,key,p12,pfx,cer,der}',
        '.npmrc', '.yarnrc.yml', '**/.git/**',
        '**/data/**', '**/uploads/**', '**/.agents/**',
        '**/.wrangler/**', '**/server/**', '**/scripts/**'
      ]
    },
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787'
      }
    }
  }
});
