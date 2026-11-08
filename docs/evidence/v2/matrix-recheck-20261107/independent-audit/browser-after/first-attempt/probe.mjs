import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, realpath, chmod } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

assert.equal(process.version, "v24.19.0", "Run this isolated probe with the pinned Node runtime.");
const root = process.cwd(), evidence = join(root, "artifacts/matrix-recheck-20261106/independent-audit/browser-after");
const require = createRequire(join(root, "package.json")), { chromium } = require("playwright");
const sha = value => createHash("sha256").update(value).digest("hex");
const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(action, message, milliseconds = 15000) {
  const deadline = Date.now() + milliseconds; let last;
  while (Date.now() < deadline) { try { last = await action(); if (last) return last; } catch (error) { last = error; } await sleep(100); }
  throw new Error(message + (last instanceof Error ? ": " + last.message : ""));
}
const sourceFiles = ["packages/host-discovery/src/marketplace.ts", "packages/capability-registry/src/discovery-catalog.ts", "apps/web/src/features/discovery/shared.tsx", "apps/web/src/features/discovery/DiscoveryDetail.tsx", "apps/web/src/features/discovery/DiscoveryList.tsx"];
const runtimeFiles = ["dist/packages/host-discovery/src/marketplace.js", "dist/packages/capability-registry/src/discovery-catalog.js", "dist/apps/daemon/src/cli.js", "web-dist/index.html", ...(await readdir(join(root, "web-dist/assets"))).filter(name => name.endsWith(".js")).map(name => "web-dist/assets/" + name)];
const capturedHashes = {};
for (const path of [...sourceFiles, ...runtimeFiles]) capturedHashes[path] = sha(await readFile(join(root, path)));
const marketplaceRuntime = await readFile(join(root, "dist/packages/host-discovery/src/marketplace.js"), "utf8");
assert.ok(marketplaceRuntime.includes("PLUGIN_MARKETPLACE_AMBIGUOUS") && marketplaceRuntime.includes("marketplaceSources"));
const webAssets = (await Promise.all(runtimeFiles.filter(path => path.endsWith(".js") && path.startsWith("web-dist/")).map(path => readFile(join(root, path), "utf8")))).join("\n");
for (const text of ["市场来源冲突", "尚未判定覆盖关系", "市场来源存在差异"]) assert.ok(webAssets.includes(text), "The current web build lacks conflict UI: " + text);

const temporary = await realpath(await mkdtemp(join(tmpdir(), "flowhub-independent-browser-after-")));
const dataDir = join(temporary, "data"), fixture = join(temporary, "fixture"), home = join(fixture, "selected-home"), project = join(fixture, "trusted-project");
const personalFile = join(fixture, ".agents/plugins/marketplace.json"), projectFile = join(project, ".agents/plugins/marketplace.json");
const fakeCli = join(fixture, "codex-owned-fixture"), callsFile = join(fixture, "codex-calls.jsonl"), hookMarker = join(fixture, "candidate-hook-executed");
const marketName = "browser-shared-market", candidateName = "browser-shared-plugin", installedName = "browser-installed-plugin";
const installedPath = join(home, "plugins/cache", marketName, installedName, "1.0");
for (const path of [dataDir, home, project, dirname(personalFile), dirname(projectFile), join(installedPath, ".codex-plugin"), join(installedPath, "skills/actual"), join(fixture, "candidate-source/skills/must-not-index")]) await mkdir(path, { recursive: true });
const config = `[plugins."${installedName}@${marketName}"]\nenabled=false\n`;
await writeFile(join(home, "config.toml"), config);
await writeFile(join(installedPath, ".codex-plugin/plugin.json"), JSON.stringify({ name: installedName, version: "1.0", description: "实际安装清单介绍，市场资料不得覆盖" }));
await writeFile(join(installedPath, "skills/actual/SKILL.md"), "---\nname: browser-installed-skill\ndescription: Synthetic installed Skill\n---\nOnly synthetic instructions; never execute shell.\n");
await writeFile(join(fixture, "candidate-source/skills/must-not-index/SKILL.md"), "---\nname: browser-market-skill-must-not-index\n---\nThis uninstalled component must not be read.\n");
await writeFile(join(fixture, "candidate-source/hooks.json"), JSON.stringify({ command: `${process.execPath} ${join(fixture, "candidate-source/hook.mjs")}` }));
await writeFile(join(fixture, "candidate-source/hook.mjs"), `import fs from 'node:fs';fs.writeFileSync(${JSON.stringify(hookMarker)},'must not execute');`);
await writeFile(fakeCli, `#!${process.execPath}\nimport fs from 'node:fs';const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(callsFile)},JSON.stringify({args,home:process.env.CODEX_HOME})+'\\n');if(args.includes('--version'))console.log('codex-cli synthetic-browser-1');else if(args.includes('--help'))console.log(args.includes('mcp')?'--json':'--profile <PROFILE>');else if(args.includes('--json'))console.log('[]');else process.exit(3);\n`);
await chmod(fakeCli, 0o755);
const entry = (name, installation, description) => ({ name, source: { source: "local", path: "./candidate-source" }, policy: { installation, authentication: "ON_INSTALL" }, category: "Productivity", description });
const personalCatalog = { name: marketName, plugins: [entry(candidateName, "AVAILABLE", "个人候选介绍"), entry(installedName, "AVAILABLE", "个人市场已装介绍")] };
const projectCatalog = { name: marketName, plugins: [entry(candidateName, "NOT_AVAILABLE", "项目候选介绍"), entry(installedName, "NOT_AVAILABLE", "项目市场已装介绍")] };
const personalBytes = JSON.stringify(personalCatalog); await writeFile(personalFile, personalBytes); await writeFile(projectFile, JSON.stringify(projectCatalog));
const receipt = { format: "flowhub.independent-audit.browser-after.v1", startedAt: new Date().toISOString(), node: process.version, platform: process.platform + "/" + process.arch, passed: false, fixture: { onlyTemporarySyntheticData: true, personalFile, projectFile, fakeCli }, capturedHashes, checks: [], screenshots: [], snapshots: [], browserRequests: [], blockedExternalRequests: [], pageErrors: [], consoleErrors: [], apiObservations: {}, cleanup: {} };
let daemon, browser, context, page, daemonStderr = "", exitPromise, base;
async function snapshot(name) {
  const path = join(evidence, name + ".aria.txt"); await writeFile(path, await page.locator("body").ariaSnapshot()); receipt.snapshots.push(path);
}
async function screenshot(name) {
  const path = join(evidence, name + ".png"); await page.screenshot({ path, fullPage: true }); receipt.screenshots.push(path);
}
async function contains(locator, text) { await until(async () => (await locator.innerText()).includes(text), "Expected rendered text: " + text); }
try {
  const env = Object.fromEntries(["SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : []));
  env.PATH = dirname(process.execPath) + ":/usr/bin:/bin"; env.CODEX_HOME = home;
  daemon = spawn(process.execPath, [join(root, "dist/apps/daemon/src/cli.js"), "serve", "--port", "0", "--data-dir", dataDir], { cwd: temporary, env, stdio: ["ignore", "ignore", "pipe"] });
  daemon.stderr.on("data", bytes => { daemonStderr = (daemonStderr + bytes.toString()).slice(-16000); });
  exitPromise = new Promise(resolve => daemon.once("exit", (code, signal) => resolve({ code, signal })));
  const endpoint = await until(async () => { assert.equal(daemon.exitCode, null, "Owned daemon exited before readiness"); try { return JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8")); } catch { return false; } }, "Owned port-0 daemon failed to start");
  assert.ok(endpoint.port > 0 && endpoint.port !== 18473 && endpoint.port !== 18479); base = "http://127.0.0.1:" + endpoint.port; receipt.ownedDaemon = { pid: daemon.pid, port: endpoint.port };
  const health = await fetch(base + "/api/v1/health"); assert.equal(health.status, 200);
  browser = await chromium.launch({ headless: true, ...(process.env.FLOWHUB_CHROMIUM ? { executablePath: process.env.FLOWHUB_CHROMIUM } : {}), args: ["--no-sandbox"] });
  context = await browser.newContext({ baseURL: base, viewport: { width: 1440, height: 1000 } });
  context.setDefaultTimeout(15000);
  await context.route("**/*", async route => { const request = route.request(), url = new URL(request.url()); if (url.origin !== base) { receipt.blockedExternalRequests.push({ method: request.method(), url: url.origin + url.pathname }); await route.abort(); } else { receipt.browserRequests.push({ method: request.method(), path: url.pathname }); await route.continue(); } });
  const auth = await context.request.post("/api/v1/auth/bootstrap", { data: { password: "Synthetic-independent-browser-password-041", setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8") } });
  assert.equal(auth.status(), 200); const csrf = (await auth.json()).data.csrf;
  const api = async (path, method = "GET", data) => { const response = await context.request.fetch(path, { method, headers: { "X-CSRF-Token": csrf }, ...(data === undefined ? {} : { data }) }); const text = await response.text(); assert.equal(response.ok(), true, path + ": " + text); return JSON.parse(text).data; };
  const registered = await api("/api/v2/host-contexts", "POST", { codexHome: home, cwd: project, codexPath: fakeCli, projectTrusted: true });
  receipt.contextId = registered.id;
  await context.addInitScript(id => localStorage.setItem("flowhub.discovery.context", id), registered.id);
  page = await context.newPage(); page.on("pageerror", error => receipt.pageErrors.push(error.message)); page.on("console", event => { if (event.type() === "error") receipt.consoleErrors.push(event.text()); });
  await page.goto("/discovery"); await page.getByRole("heading", { name: "Codex 能力发现", exact: true }).waitFor(); await snapshot("01-initial");
  const getOverview = () => api("/api/v2/discovery/catalog?contextId=" + registered.id + "&kind=plugin&limit=100");
  const before = await until(async () => { const result = await getOverview(); return result.items.length === 2 && result.items.every(item => item.marketplaceConflict) ? result : false; }, "Initial conflict scan did not complete");
  assert.equal(before.status, "PARTIAL"); assert.equal(before.counts.plugin, 1); assert.equal(before.availablePluginCount, null); assert.equal(before.items.filter(item => item.installation === "available_only").length, 1);
  const candidate = before.items.find(item => item.name === candidateName), actual = before.items.find(item => item.name === installedName);
  assert.equal(candidate.availability, "ambiguous"); assert.equal(actual.installation, "installed"); assert.equal(actual.enabled, false); assert.equal(actual.description, "实际安装清单介绍，市场资料不得覆盖");
  receipt.apiObservations.before = before;
  await contains(page.locator(".d-scan-status"), "部分完成");
  await contains(page.locator(".d-stat").filter({ hasText: "已安装插件" }).locator("strong"), "1");
  assert.equal(await page.getByText(/另有 \d+ 个市场可用插件尚未安装/).count(), 0);
  await page.getByRole("tab", { name: /插件与关系/ }).click(); await until(async () => await page.locator(".d-plugin-card").count() === 2, "Plugin cards not rendered"); await snapshot("02-conflict-cards");
  const candidateCard = page.locator(".d-plugin-card").filter({ has: page.getByRole("heading", { name: candidateName, exact: true }) });
  const installedCard = page.locator(".d-plugin-card").filter({ has: page.getByRole("heading", { name: installedName, exact: true }) });
  await contains(candidateCard, "市场来源冲突 · 未安装"); await contains(candidateCard, "市场来源存在差异，尚未安装"); await contains(installedCard, "已安装 · 已停用 · 市场来源冲突"); await screenshot("02-conflict-cards");
  await candidateCard.getByRole("button", { name: /插件详情/ }).click(); const drawer = page.getByRole("dialog"); await contains(drawer, "市场来源差异"); await snapshot("03-candidate-conflict-detail");
  for (const text of [personalFile, projectFile, "个人候选介绍", "项目候选介绍", "AVAILABLE", "NOT_AVAILABLE", "尚未判定覆盖关系"]) await contains(drawer, text);
  assert.equal(await drawer.getByRole("button", { name: /导入|连接|添加到/ }).count(), 0); await drawer.getByRole("heading", { name: "市场来源差异", exact: true }).scrollIntoViewIfNeeded(); await screenshot("03-candidate-conflict-detail");
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await installedCard.getByRole("button", { name: /插件详情/ }).click(); await contains(drawer, "实际安装清单介绍，市场资料不得覆盖"); await contains(drawer, "browser-installed-skill"); await contains(drawer, "市场来源差异"); await snapshot("04-installed-conflict-detail"); await drawer.getByRole("heading", { name: "市场来源差异", exact: true }).scrollIntoViewIfNeeded(); await screenshot("04-installed-conflict-detail");
  const installedBefore = await api("/api/v2/discovery/entities/" + actual.id); assert.equal(installedBefore.children.length, 1); assert.equal(installedBefore.children[0].enabled, false);
  await page.getByRole("button", { name: "关闭详情", exact: true }).click();
  await writeFile(projectFile, personalBytes);
  await page.getByRole("button", { name: "重新扫描", exact: true }).click();
  const after = await until(async () => { const result = await getOverview(); return result.scanId !== before.scanId && result.status === "SUCCEEDED" && result.items.length === 2 && result.items.every(item => !item.marketplaceConflict) ? result : false; }, "Equal-source scan did not clear conflicts");
  receipt.apiObservations.after = after; assert.equal(after.counts.plugin, 1); assert.equal(after.availablePluginCount, 1);
  const resolved = after.items.find(item => item.id === candidate.id), installedAfter = await api("/api/v2/discovery/entities/" + actual.id);
  assert.equal(resolved.availability, "available_only"); assert.equal(resolved.marketplaceSources.length, 2); assert.equal(resolved.description, "个人候选介绍");
  for (const field of ["id", "installation", "availability", "enabled", "description", "manifestHash", "version"]) assert.deepEqual(installedAfter[field], installedBefore[field], "Installed fact changed: " + field);
  assert.deepEqual(installedAfter.children.map(item => [item.id, item.capabilityId, item.enabled]), installedBefore.children.map(item => [item.id, item.capabilityId, item.enabled]));
  await contains(page.locator(".d-scan-status"), "扫描完成"); await contains(candidateCard, "可用，尚未安装"); await contains(installedCard, "已停用");
  assert.equal((await installedCard.innerText()).includes("市场来源冲突"), false); await contains(page.getByText("另有 1 个市场可用插件尚未安装，可在“插件与关系”查看。", { exact: true }), "另有 1 个");
  await snapshot("05-resolved-cards"); await screenshot("05-resolved-cards");
  await candidateCard.getByRole("button", { name: /插件详情/ }).click(); await contains(drawer, "市场来源记录"); await contains(drawer, personalFile); await contains(drawer, projectFile); assert.equal((await drawer.innerText()).includes("尚未判定覆盖关系"), false); await snapshot("06-resolved-candidate-detail"); await drawer.getByRole("heading", { name: "市场来源记录", exact: true }).scrollIntoViewIfNeeded(); await screenshot("06-resolved-candidate-detail");
  await page.getByRole("button", { name: "关闭详情", exact: true }).click(); await page.reload(); await contains(page.locator(".d-stat").filter({ hasText: "已安装插件" }).locator("strong"), "1"); await contains(page.getByText("另有 1 个市场可用插件尚未安装，可在“插件与关系”查看。", { exact: true }), "另有 1 个"); await snapshot("07-reloaded-resolved");
  assert.deepEqual(await api("/api/v2/model-profiles"), []); const skills = await api("/api/v2/capabilities?contextId=" + registered.id + "&kind=skill&limit=100"); assert.ok(skills.items.some(item => item.name === "browser-installed-skill")); assert.ok(!skills.items.some(item => item.name === "browser-market-skill-must-not-index"));
  assert.equal(await readFile(join(home, "config.toml"), "utf8"), config); assert.equal(await readFile(personalFile, "utf8"), personalBytes); await assert.rejects(readFile(hookMarker), { code: "ENOENT" });
  const calls = (await readFile(callsFile, "utf8")).trim().split("\n").map(line => JSON.parse(line)); assert.ok(calls.every(call => call.home === home)); assert.ok(calls.every(call => !call.args.includes("exec"))); receipt.fakeCliCalls = calls;
  assert.deepEqual(receipt.blockedExternalRequests, []); assert.deepEqual(receipt.pageErrors, []); assert.ok(!receipt.browserRequests.some(request => /\/assistant\/|\/test-runs|\/api\/v1\/runs/.test(request.path))); 
  receipt.checks = ["Real rendered conflict candidate card and installed card", "Detail displays both source paths, descriptions and policies without precedence", "Conflicting candidate excluded from available count", "Real UI rescan clears conflict after second-source metadata is made equal", "Installed manifest, disabled state and Skill identity retained", "Reload retains resolved state", "No model profile, external request, business run or candidate hook"]; receipt.passed = true;
} catch (error) {
  receipt.error = { name: error.name, message: error.message, stack: error.stack }; if (page) { try { await snapshot("failure"); await screenshot("failure"); } catch {} } process.exitCode = 1;
} finally {
  if (browser) { await browser.close(); receipt.cleanup.browserClosed = true; }
  if (daemon && daemon.exitCode === null) { daemon.kill("SIGTERM"); const stopped = await Promise.race([exitPromise, sleep(5000).then(() => null)]); if (stopped) receipt.cleanup.daemon = stopped; else { daemon.kill("SIGKILL"); receipt.cleanup.daemon = await exitPromise; receipt.cleanup.requiredForcedKill = true; } }
  else if (exitPromise) receipt.cleanup.daemon = await exitPromise;
  await writeFile(join(evidence, "daemon.stderr.log"), daemonStderr);
  for (const [path, expected] of Object.entries(capturedHashes)) assert.equal(sha(await readFile(join(root, path))), expected, "Frozen source/runtime changed during browser probe: " + path);
  receipt.finishedAt = new Date().toISOString(); await rm(temporary, { recursive: true, force: true }); receipt.cleanup.temporaryDataRemoved = true;
  await writeFile(join(evidence, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n"); console.log(JSON.stringify({ passed: receipt.passed, error: receipt.error, ownedDaemon: receipt.ownedDaemon, checks: receipt.checks, screenshots: receipt.screenshots, cleanup: receipt.cleanup, evidence: join(evidence, "receipt.json") }, null, 2));
}
