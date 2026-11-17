import { defineConfig } from "@playwright/test";

// Boots the REAL stack from the production builds (run `pnpm e2e` from the repo root, which builds
// first): API on 3201 and web on 3200, against the Postgres in DATABASE_URL.
const WEB = 3200;
const API = 3201;
const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgres://orbyt:orbyt@127.0.0.1:5432/orbyt";

export default defineConfig({
  testDir: "./tests",
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  globalTeardown: "./teardown.ts",
  use: { baseURL: `http://localhost:${WEB}`, trace: "retain-on-failure" },
  webServer: [
    {
      command: "node dist/main.js",
      cwd: "../apps/api",
      url: `http://127.0.0.1:${API}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL,
        PORT: String(API),
        HOST: "127.0.0.1",
        BETTER_AUTH_SECRET: "e2e-secret-e2e-secret-e2e-secret-123456",
        // The browser talks to the WEB origin; the API checks the Origin header against this.
        BETTER_AUTH_URL: `http://localhost:${WEB}`,
        ORBYT_ALLOW_PRIVATE_URLS: "true",
        // Fast background loops so the email test does not wait a minute for the scheduler/sync.
        ORBYT_SCHEDULER_INTERVAL_MS: "1000",
        ORBYT_SYNC_INTERVAL_MS: "1500",
        ORBYT_WORKFLOWS_INTERVAL_MS: "1000",
        ORBYT_NO_JITTER: "true",
      },
    },
    {
      command: `node node_modules/next/dist/bin/next start -p ${WEB}`,
      cwd: "../apps/web",
      url: `http://localhost:${WEB}`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_INTERNAL_URL: `http://127.0.0.1:${API}` },
    },
  ],
});
