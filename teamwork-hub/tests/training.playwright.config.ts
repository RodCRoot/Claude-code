import { defineConfig } from "@playwright/test";

/**
 * Training module browser tests (offline recovery). Run against a dev server on :3105
 * with the demo seed loaded:
 *   pnpm db:fresh && pnpm exec playwright test -c tests/training.playwright.config.ts
 * Starts `next dev -p 3105` if nothing is listening there.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /training-.*\.e2e\.ts$/,
  timeout: 120_000,
  workers: 1,
  use: {
    baseURL: process.env.TRAINING_E2E_BASE_URL ?? "http://localhost:3105",
    launchOptions: { executablePath: process.env.PW_CHROMIUM ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" },
    viewport: { width: 390, height: 844 },
  },
  webServer: {
    command: "pnpm exec next dev -p 3105",
    url: "http://localhost:3105/login",
    reuseExistingServer: true,
    timeout: 120_000,
    cwd: "..",
  },
});
