import { defineConfig } from "@playwright/test";

/**
 * Training module browser tests (offline recovery + service worker, shared-tablet cache safety,
 * program builder keyboard/drag-and-drop). The training service worker is only registered in
 * production builds, so these run against `next start` on :3105 with the demo seed loaded:
 *   pnpm db:fresh && pnpm build && pnpm exec playwright test -c tests/training.playwright.config.ts
 * Starts `next start -p 3105` (building first if there is no build) unless something is
 * listening there already; set TRAINING_E2E_BASE_URL to reuse a running server.
 */
// Lets context.route() see the service worker's own requests (Chromium), so the offline test can
// cut the worker's network too — context.setOffline() alone only affects pages.
process.env.PW_EXPERIMENTAL_SERVICE_WORKER_NETWORK_EVENTS ??= "1";

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
  webServer: process.env.TRAINING_E2E_BASE_URL
    ? undefined
    : {
        command: "sh -c 'test -f .next/BUILD_ID || pnpm build; pnpm exec next start -p 3105'",
        url: "http://localhost:3105/login",
        reuseExistingServer: true,
        timeout: 600_000,
        cwd: "..",
      },
});
