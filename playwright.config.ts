import { defineConfig } from "@playwright/test";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir =
  process.env.FLOWHUB_UI_DATA_DIR ?? mkdtempSync(join(tmpdir(), "flowhub-ui-"));
process.env.FLOWHUB_UI_DATA_DIR = dataDir;
const executablePath =
  process.env.FLOWHUB_CHROMIUM ??
  (existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : undefined);
export default defineConfig({
  testDir: "tests/ui",
  timeout: 60000,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:18479",
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command:
      'node dist/apps/daemon/src/cli.js serve --port 18479 --data-dir "' +
      dataDir +
      '"',
    url: "http://127.0.0.1:18479/api/v1/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
