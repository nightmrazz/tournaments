import { defineConfig, devices } from '@playwright/test';

// E2E runs against the local (browser-storage) data mode, so no Supabase project is needed.
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  use: { baseURL: 'http://localhost:4173', trace: 'retain-on-failure' },
  // Uses the locally installed Microsoft Edge (no browser download). Set PW_CHANNEL=chromium after
  // `npx playwright install chromium` to use the bundled browser instead (e.g. in CI).
  projects: [{ name: 'desktop', use: { ...devices['Desktop Chrome'], channel: process.env.PW_CHANNEL ?? 'msedge' } }],
  webServer: {
    command: 'npm run build && npx vite preview --port 4173 --strictPort',
    url: 'http://localhost:4173',
    reuseExistingServer: true,
    timeout: 180_000,
    env: { VITE_SUPABASE_URL: '', VITE_SUPABASE_ANON_KEY: '' },
  },
});
