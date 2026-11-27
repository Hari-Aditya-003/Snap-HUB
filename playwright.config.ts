import { defineConfig, devices } from "@playwright/test";

// Browser smoke coverage for the guest gallery and moderation. The specs boot
// the built Worker through `wrangler dev` on a temporary local D1 database
// (same pattern as tests/standalone-cloudflare.test.mjs), so `npm run build`
// must have run first — the `test:browser` script does this for you.
//
// One-time prerequisite: `npx playwright install --with-deps chromium`.
export default defineConfig({
  testDir: "tests/browser",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: "list",
  use: {
    ...devices["Desktop Chrome"],
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
