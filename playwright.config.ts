import { defineConfig } from "@playwright/test";
import { mkdtempSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dataDir =
  process.env.FLOWHUB_UI_DATA_DIR ?? mkdtempSync(join(tmpdir(), "flowhub-ui-"));
process.env.FLOWHUB_UI_DATA_DIR = dataDir;
// The UI process and its daemon use an empty test home, never the user's Codex config.
mkdirSync(dataDir,{recursive:true});
const codexHome=mkdtempSync(join(dataDir,"empty-codex-home-"));
writeFileSync(join(codexHome,"config.toml"),"");
process.env.CODEX_HOME=codexHome;
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
    trace: "retain-on-failure",
    viewport: { width: 1440, height: 900 },
    launchOptions: {
      ...(executablePath ? { executablePath } : {}),
      args: ["--no-sandbox"],
    },
  },
  webServer: {
    command: 'node scripts/ui-server.mjs',
    url: "http://127.0.0.1:18479/api/v1/health",
    reuseExistingServer: false,
    timeout: 20000,
  },
});
