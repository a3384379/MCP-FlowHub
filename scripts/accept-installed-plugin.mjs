import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  realpath,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

// Exercise the installed package through real Codex and public management APIs.
// The user's plugin registration, connection reference and business DB are untouched.
const exec = promisify(execFile);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const repo = resolve(".");
const userHome = process.env.CODEX_HOME || join(homedir(), ".codex");
const { locateCodex } = await import(
  "../dist/packages/host-discovery/src/index.js"
);
const codex = process.env.FLOWHUB_CODEX_PATH || (await locateCodex());
assert.ok(codex, "Actual Codex executable required");
async function packagePath() {
  if (process.env.FLOWHUB_PLUGIN_CANDIDATE)
    return resolve(process.env.FLOWHUB_PLUGIN_CANDIDATE);
  const configured = JSON.parse(
    (
      await exec(codex, ["mcp", "get", "flowhub", "--json"], {
        env: { ...process.env, CODEX_HOME: userHome },
        timeout: 20000,
      })
    ).stdout,
  );
  assert.equal(configured.transport?.type, "stdio");
  return dirname(dirname(configured.transport.command));
}
const installed = await packagePath();
assert.equal(
  JSON.parse(await readFile(join(installed, "plugin.json"), "utf8")).name,
  "flowhub",
);
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const out = join(repo, "artifacts", "plugin-e2e-" + stamp);
await mkdir(join(out, "private", "codex"), { recursive: true, mode: 0o700 });
const root = await realpath(join(out, "private"));
const home = join(root, "codex"),
  dataDir = join(root, "data"),
  cwd = join(root, "project");
await mkdir(cwd);
const env = Object.fromEntries(
  ["SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap((k) =>
    process.env[k] ? [[k, process.env[k]]] : [],
  ),
);
Object.assign(env, {
  HOME: root,
  USERPROFILE: root,
  LOCALAPPDATA: root,
  CODEX_HOME: home,
  PATH: join(installed, "runtime"),
});
const userFiles = [
  join(userHome, "config.toml"),
  join(userHome, "flowhub/connection.json"),
];
const protectedHashes = await Promise.all(
  userFiles.map(async (file) => ({ file, sha256: sha(await readFile(file)) })),
);
const report = {
  startedAt: new Date().toISOString(),
  installed,
  codex,
  dataDir,
  output: out,
  stages: [],
  completed: false,
  modelTurns: 0,
  enterpriseCalls: 0,
  paidProviderCalls: 0,
};
const children = [];
let rpc,
  lines,
  pending = new Map(),
  seq = 0,
  cookie,
  csrf,
  base;
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit");
  child.kill("SIGTERM");
  const force = setTimeout(() => child.kill("SIGKILL"), 5000);
  try {
    await ended;
  } finally {
    clearTimeout(force);
  }
}
async function stage(name, action) {
  const start = Date.now(),
    record = { name, status: "RUNNING" };
  report.stages.push(record);
  console.log(JSON.stringify({ stage: name, event: "start" }));
  try {
    const details = await action();
    Object.assign(record, { status: "PASS" }, details);
    return details;
  } catch (error) {
    record.status = "FAIL";
    record.error = error.message;
    throw error;
  } finally {
    record.durationMs = Date.now() - start;
    console.log(JSON.stringify(record));
  }
}
function safeReceipt(value) {
  if (Array.isArray(value)) return value.map(safeReceipt);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([k]) => k !== "checkpointToken")
      .map(([k, v]) => [
        k,
        k === "checkpoint" && v
          ? safeReceipt(
              Object.fromEntries(
                Object.entries(v).filter(([key]) => key !== "token"),
              ),
            )
          : safeReceipt(v),
      ]),
  );
}
async function tool(name, args, expectedError) {
  const result = await rpc("mcpServer/tool/call", {
    threadId: report.threadId,
    server: "flowhub",
    tool: name,
    arguments: args,
  });
  const value = result.structuredContent ?? JSON.parse(result.content[0].text);
  await appendFile(
    join(out, "mcp-receipts.jsonl"),
    JSON.stringify({
      tool: name,
      arguments: safeReceipt(args),
      result: safeReceipt(value),
      isError: result.isError === true,
    }) + "\n",
  );
  if (expectedError) {
    assert.equal(result.isError, true);
    assert.equal(value.error?.code ?? value.errorCode, expectedError);
  } else if (result.isError)
    throw new Error(
      name +
        ": " +
        (value.error?.code ?? value.errorCode) +
        " " +
        (value.error?.message ?? ""),
    );
  return value;
}
async function api(route, payload) {
  const response = await fetch(base + route, {
    method: payload === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      ...(cookie ? { Cookie: cookie, "X-CSRF-Token": csrf } : {}),
    },
    ...(payload !== undefined ? { body: JSON.stringify(payload) } : {}),
  });
  const json = await response.json();
  if (!response.ok)
    throw new Error(
      route + ": HTTP " + response.status + " " + (json.error?.code ?? ""),
    );
  return json.data;
}
async function poll(name, args, terminal, field = "status") {
  const deadline = Date.now() + 45000;
  while (Date.now() < deadline) {
    const value = await tool(name, args);
    if (terminal.includes(value[field])) return value;
    await sleep(75);
  }
  throw new Error("Timed out: " + name);
}
async function fixtureCalls() {
  try {
    return (await readFile(join(root, "business-calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

try {
  await stage("installed_package_and_isolated_runtime", async () => {
    const manifest = JSON.parse(
      await readFile(join(installed, "manifest.sha256.json"), "utf8"),
    );
    for (const [file, hash] of Object.entries(manifest))
      assert.equal(
        sha(await readFile(join(installed, file))),
        hash,
        "Installed file changed: " + file,
      );
    const installedRequire = createRequire(join(installed, "package.json"));
    const serverImport = pathToFileURL(
      installedRequire.resolve("@modelcontextprotocol/server"),
    ).href;
    const stdioImport = pathToFileURL(
      installedRequire.resolve("@modelcontextprotocol/server/stdio"),
    ).href;
    const mock = await import(
      pathToFileURL(join(installed, "dist/packages/mock-mcps/src/index.js"))
    );
    const fixture = join(root, "order-lab.mjs");
    await writeFile(
      fixture,
      `import {appendFile} from 'node:fs/promises';import {McpServer,fromJsonSchema} from ${JSON.stringify(serverImport)};import {serveStdio} from ${JSON.stringify(stdioImport)};
serveStdio(()=>{const server=new McpServer({name:'order-plugin-e2e-lab',version:'1'},{capabilities:{tools:{}}});server.registerTool('synthetic_order_lookup',{description:'Local synthetic order lookup for FlowHub plugin acceptance. Never accesses enterprise services.',inputSchema:fromJsonSchema(${JSON.stringify(mock.mockInputSchema)}),outputSchema:fromJsonSchema(${JSON.stringify(mock.mockOutputSchema)}),annotations:{readOnlyHint:true}},async({orderNo})=>{await appendFile(${JSON.stringify(join(root, "business-calls.jsonl"))},JSON.stringify({tool:'synthetic_order_lookup',orderNo})+'\\n');const value={synthetic:true,environment:'test',sentinel:'FLOWHUB_S0_TEST_ONLY_041',orderNo,message:'合成订单 · 中文与 emoji ✅'};return {content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value};});return server;},{legacy:'serve'});\n`,
    );
    await writeFile(
      join(home, "config.toml"),
      [
        "[features]",
        "apps = false",
        "plugins = true",
        "remote_plugin = false",
        "[mcp_servers.order_lab]",
        "command = " + JSON.stringify(join(installed, "runtime/node")),
        "args = [" + JSON.stringify(fixture) + "]",
      ].join("\n"),
    );
    await exec(codex, ["plugin", "marketplace", "add", installed], {
      env,
      cwd,
      timeout: 60000,
    });
    const installation = JSON.parse(
      (
        await exec(
          codex,
          ["plugin", "add", "flowhub@flowhub-local", "--json"],
          { env, cwd, timeout: 60000 },
        )
      ).stdout,
    );
    const isolated = installation.installedPath;
    for (const file of [
      "scripts/flowhub-plugin.mjs",
      "dist/apps/daemon/src/cli.js",
      "contracts/mcp-v2-tool-inputs.schema.json",
      "runtime/node",
    ])
      assert.equal(sha(await readFile(join(isolated, file))), manifest[file]);
    await exec(
      join(installed, "runtime/node"),
      [
        join(installed, "scripts/flowhub-plugin.mjs"),
        "configure",
        "--data-dir",
        dataDir,
      ],
      { env, cwd },
    );
    const daemon = spawn(
      join(installed, "runtime/node"),
      [join(installed, "scripts/flowhub-plugin.mjs"), "start", "--port", "0"],
      { env, cwd, stdio: ["ignore", "ignore", "pipe"] },
    );
    children.push(daemon);
    daemon.stderr.resume();
    for (let i = 0; i < 200; i++) {
      try {
        base =
          "http://127.0.0.1:" +
          JSON.parse(await readFile(join(dataDir, "endpoint.json"), "utf8"))
            .port;
        break;
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      await sleep(50);
    }
    assert.ok(base, "Isolated daemon ready");
    const shortcut = await exec(
      join(isolated, "runtime/node"),
      [join(isolated, "scripts/flowhub-plugin.mjs"), "url"],
      { env, cwd },
    );
    assert.equal(shortcut.stdout.trim(), base + "/");
    const page = await fetch(shortcut.stdout.trim());
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>.*FlowHub/i);
    const session = await fetch(base + "/api/v1/auth/local-session", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Origin": base,
        "X-FlowHub-Local": "1",
      },
      body: "{}",
    });
    assert.equal(session.status, 200);
    csrf = (await session.json()).data.csrf;
    cookie = session.headers.get("set-cookie").split(";")[0];
    await api("/api/v1/vault/initialize", { password: "Synthetic-plugin-e2e-vault" });
    const child = spawn(codex, ["app-server", "--stdio"], {
      env,
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.push(child);
    child.stderr.resume();
    lines = createInterface({ input: child.stdout });
    rpc = (method, params) =>
      new Promise((resolve, reject) => {
        const id = ++seq,
          timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error("Codex RPC timeout: " + method));
          }, 30000);
        pending.set(id, { resolve, reject, timer });
        child.stdin.write(JSON.stringify({ id, method, params }) + "\n");
      });
    lines.on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        clearTimeout(waiter.timer);
        message.error
          ? waiter.reject(new Error("Codex RPC " + message.error.code))
          : waiter.resolve(message.result);
      } else if (message.id !== undefined && message.method)
        child.stdin.write(
          JSON.stringify({
            id: message.id,
            error: {
              code: -32601,
              message: "No interactive actions during protocol acceptance",
            },
          }) + "\n",
        );
    });
    const initialized = await rpc("initialize", {
      clientInfo: { name: "flowhub-installed-e2e", version: "1" },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(
      JSON.stringify({ method: "initialized", params: {} }) + "\n",
    );
    report.threadId = (
      await rpc("thread/start", {
        cwd,
        ephemeral: true,
        approvalPolicy: "never",
        sandbox: "read-only",
      })
    ).thread.id;
    const inventory = await rpc("mcpServerStatus/list", {
      threadId: report.threadId,
      serverName: "flowhub",
      detail: "toolsAndAuthOnly",
      limit: 10,
    });
    assert.equal(Object.keys(inventory.data[0].tools).length, 21);
    const sidebar = inventory.data[0].tools.project_help_search;
    assert.deepEqual(sidebar._meta?.["openai/ui"]?.entrypoints, [{ type: "global" }]);
    const resourceUri = sidebar._meta?.ui?.resourceUri;
    assert.ok(/^ui:\/\/flowhub\/management-/.test(resourceUri));
    const resource = await rpc("mcpServer/resource/read", {
      threadId: report.threadId, server: "flowhub", uri: resourceUri,
    });
    assert.equal(resource.contents[0].mimeType, "text/html;profile=mcp-app");
    assert.deepEqual(resource.contents[0]._meta["openai/ui"].availableDisplayModes, ["fullscreen"]);
    assert.doesNotMatch(resource.contents[0].text, /<iframe[\s>]/i);
    assert.match(resource.contents[0].text, /校验与自测/);
    const launch = await rpc("mcpServer/tool/call", {
      threadId: report.threadId, server: "flowhub", tool: "project_help_search", arguments: {},
    });
    assert.equal(launch.structuredContent.opened, true);
    assert.ok(launch._meta?.["flowhub/workflows"]?.items.some(item => item.workflowId === "incident-production"),
      "Codex preserves the app-only workflow index");
    assert.equal(launch._meta?.["flowhub/launch"], undefined);
    const skills = (
      await rpc("skills/list", { cwds: [cwd], forceReload: true })
    ).data
      .flatMap((row) => row.skills)
      .filter((item) => item.name.startsWith("flowhub:"))
      .map((item) => item.name)
      .sort();
    assert.equal(skills.length, 3);
    const { plugin } = await rpc("plugin/read", {
      marketplacePath: join(installed, ".agents/plugins/marketplace.json"),
      pluginName: "flowhub",
    });
    assert.ok(
      plugin.summary.interface.defaultPrompt.includes("打开 FlowHub 管理页面"),
    );
    return {
      packageVersion: JSON.parse(await readFile(join(installed, "plugin.json")))
        .version,
      codexUserAgent: initialized.userAgent,
      tools: 21,
      skills,
      separateDataDir: true,
      installedBytesMatch: true,
      globalSidebarResource: resourceUri,
      emptyArgumentLaunch: true,
      dashboardPrompt: "打开 FlowHub 管理页面",
      isolatedDashboardUrl: shortcut.stdout.trim(),
    };
  });

  await stage("real_user_metadata_readonly", async () => {
    const context = await api("/api/v2/host-contexts", {
      codexHome: userHome,
      cwd: repo,
      codexPath: null,
      discoveryMode: "config_only",
      projectTrusted: false,
      useAppServer: false,
    });
    const scan = await tool("host_scan", {
      contextId: context.id,
      depth: "metadata",
      idempotencyKey: "personal-metadata",
    });
    const status = await poll("host_scan_status", { scanId: scan.scanId }, [
      "SUCCEEDED",
      "PARTIAL",
      "FAILED",
    ]);
    assert.notEqual(status.status, "FAILED");
    const counts = {};
    for (const kind of ["mcp_server", "plugin", "skill"]) {
      let cursor;
      const items = [];
      do {
        const page = await tool("capability_search", {
          contextId: context.id,
          kind,
          query: "",
          limit: 100,
          ...(cursor ? { cursor } : {}),
        });
        items.push(...page.items);
        cursor = page.nextCursor;
      } while (cursor);
      counts[kind] = items.length;
      if (kind === "plugin") {
        const chrome = status.components.find(
          (item) =>
            item.kind === "plugin" &&
            item.sourceKey === "chrome@openai-bundled",
        );
        if (chrome) counts.chromeVersion = chrome.version;
      }
    }
    assert.ok(counts.plugin > 0 && counts.skill > 0);
    return {
      scanId: scan.scanId,
      scanStatus: status.status,
      mode: "config_only",
      counts,
      issues: status.issues.map((item) => item.code),
      liveCatalogNotClaimed: true,
    };
  });

  let context, cap, imported, binding, revision, goodCases, goodSuite, goodTest;
  const workflowId = "plugin-e2e-" + Date.now();
  report.workflowId = workflowId;
  await stage(
    "discover_catalog_local_fixture_and_chinese_description",
    async () => {
      context = await api("/api/v2/host-contexts", {
        codexHome: home,
        cwd,
        codexPath: codex,
        projectTrusted: true,
        useAppServer: true,
      });
      const scan = await tool("host_scan", {
        contextId: context.id,
        depth: "catalog",
        idempotencyKey: "fixture-catalog",
      });
      const status = await poll("host_scan_status", { scanId: scan.scanId }, [
        "SUCCEEDED",
        "PARTIAL",
        "FAILED",
      ]);
      assert.ok(
        !status.issues.some((issue) => issue.code === "APP_SERVER_PARTIAL"),
        JSON.stringify(status.issues),
      );
      assert.ok(
        status.components.some(
          (component) => component.kind === "skill" && component.hostReported,
        ),
      );
      assert.ok(
        status.components.some(
          (component) =>
            component.kind === "host_tool" &&
            component.serverName === "order_lab",
        ),
      );
      const found = await tool("capability_search", {
        contextId: context.id,
        kind: "mcp_tool",
        executor: "hub_direct",
        query: "synthetic_order_lookup",
      });
      cap = found.items.find((item) => item.name === "synthetic_order_lookup");
      assert.ok(cap);
      const details = await tool("capability_get", {
        capabilityId: cap.id,
        includeSchemas: true,
      });
      assert.ok(details.inputSchema.properties.orderNo);
      assert.equal(
        (await fixtureCalls()).length,
        0,
        "Catalog discovery never invokes the business tool",
      );
      const entity = cap.discovery;
      await tool("host_scan", {
        contextId: context.id,
        action: "submit_descriptions",
        expectedContextRevision: context.revision,
        idempotencyKey: "chinese",
        entries: [
          {
            entityId: entity.id,
            entityKind: entity.entityKind,
            expectedSourceRevision: entity.revision,
            sourceFingerprint: entity.sourceFingerprint,
            expectedPresentationRevision: entity.presentation.revision,
            locale: "zh-CN",
            displayName: "插件验收：合成订单查询",
            summary: "按订单号读取本地合成订单，校验中文和原始业务字段。",
            evidenceRefs: [entity.evidenceRefs[0]],
          },
        ],
      });
      assert.ok(
        (
          await tool("capability_search", {
            contextId: context.id,
            query: "合成订单",
          })
        ).items.some(
          (item) =>
            item.id === cap.id &&
            item.discovery.displayName === "插件验收：合成订单查询",
        ),
      );
      imported = await tool("capability_import", {
        capabilityId: cap.id,
        expectedSourceRevision: cap.revision,
        target: "hub_direct",
        environment: "test",
        lockedArguments: {},
        idempotencyKey: "import-fixture",
      });
      assert.equal(imported.status, "configuration_required");
      assert.equal((await fixtureCalls()).length, 0);
      binding = await api(
        "/api/v1/bindings/" + imported.bindingId + "/verify",
        {
          probe: {
            toolName: cap.name,
            arguments: { orderNo: "DEMO-PLUGIN-CHECK" },
          },
          serverEnforcedReadOnly: true,
          scope: "Isolated synthetic plugin acceptance only",
          expectedEnvironmentPointer: "/environment",
        },
      );
      assert.equal(binding.validationStatus, "MOCK_VERIFIED");
      assert.equal(binding.simulationOnly, true);
      return {
        scanId: scan.scanId,
        scanStatus: status.status,
        issues: status.issues.map((item) => item.code),
        capabilityId: cap.id,
        capabilityRevision: cap.revision,
        executor: cap.executor,
        bindingId: binding.id,
        bindingValidation: binding.validationStatus,
        catalogBusinessCalls: 0,
      };
    },
  );

  await stage("author_7_node_workflow_atomicity_cas_idempotency", async () => {
    const created = await tool("workflow_draft_create", {
      workflowId,
      name: "插件实测：合成订单核对与报告",
      environment: "test",
      mode: "guided",
      template: "blank",
      idempotencyKey: "create",
    });
    const ref = (source, pointer = "", nodeId) => ({
      ref: { source, pointer, ...(nodeId ? { nodeId } : {}) },
    });
    const ops = [
      {
        op: "set_input_schema",
        schema: {
          type: "object",
          properties: {
            orderNo: {
              type: "string",
              pattern: "^DEMO-[A-Za-z0-9-]{1,64}$",
              examples: ["DEMO-PLUGIN-01"],
            },
            needDetails: { type: "boolean" },
          },
          required: ["orderNo", "needDetails"],
          additionalProperties: false,
          examples: [{ orderNo: "DEMO-PLUGIN-01", needDetails: true }],
        },
      },
      { op: "set_binding", key: "lookup", bindingId: imported.bindingId },
      ...["lookup", "detail"].map((nodeId) => ({
        op: "add_node",
        nodeId,
        nodeType: "mcp_tool",
        title: nodeId === "lookup" ? "查询合成订单" : "按条件补充核对",
        capabilityRef: { capabilityId: cap.id, revision: cap.revision },
        config: {
          bindingKey: "lookup",
          argumentsMappings: { "/orderNo": ref("input", "/orderNo") },
        },
      })),
      {
        op: "add_node",
        nodeId: "analysis",
        nodeType: "agent_task",
        title: "Codex 整理合成回执",
        config: {
          kind: "analysis",
          instructions:
            "Summarize only the supplied synthetic lookup. Preserve original business fields.",
          inputMappings: { "/lookup": ref("node", "", "lookup") },
          outputSchema: {
            type: "object",
            properties: { summary: { type: "string", minLength: 1 } },
            required: ["summary"],
            additionalProperties: false,
          },
          executorRef: "codex_host",
        },
      },
      {
        op: "add_node",
        nodeId: "branch",
        nodeType: "condition",
        title: "是否补充核对",
        config: {
          expression: {
            op: "eq",
            left: ref("input", "/needDetails"),
            right: { value: true },
          },
        },
      },
      {
        op: "add_node",
        nodeId: "report",
        nodeType: "report_template",
        title: "生成证据报告",
        config: {
          templateRef: "incident-markdown/v1",
          inputMappings: {
            "/analysis": ref("node", "", "analysis"),
            "/lookup": ref("node", "", "lookup"),
            "/orderNo": ref("input", "/orderNo"),
            "/question": {
              value: "插件完整链路验收：仅核对本地合成订单，不作生产排障结论。",
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              reportMarkdown: { type: "string" },
              evidenceRefs: { type: "array", items: { type: "string" } },
            },
            required: ["reportMarkdown", "evidenceRefs"],
            additionalProperties: false,
          },
        },
      },
      { op: "disconnect", source: "input", target: "end", port: "next" },
      ...[
        ["input", "lookup", "next"],
        ["lookup", "analysis", "next"],
        ["analysis", "branch", "next"],
        ["branch", "detail", "true"],
        ["branch", "report", "false"],
        ["detail", "report", "next"],
        ["report", "end", "next"],
      ].map(([source, target, port]) => ({
        op: "connect",
        source,
        target,
        port,
      })),
    ];
    const request = {
      workflowId,
      expectedRevision: created.revision,
      idempotencyKey: "wire",
      operations: ops,
    };
    const patched = await tool("workflow_draft_patch", request);
    revision = patched.revision;
    assert.deepEqual(await tool("workflow_draft_patch", request), patched);
    await tool(
      "workflow_draft_patch",
      {
        workflowId,
        expectedRevision: created.revision,
        idempotencyKey: "wrong-cas",
        operations: [
          {
            op: "update_node",
            nodeId: "report",
            changes: { title: "must not be saved" },
          },
        ],
      },
      "REVISION_CONFLICT",
    );
    const draft = await tool("workflow_draft_get", { workflowId });
    assert.equal(draft.revision, revision);
    assert.equal(draft.draft.nodes.length, 7);
    const checked = await tool("workflow_draft_validate", {
      workflowId,
      expectedRevision: revision,
      level: "publish",
    });
    assert.equal(checked.valid, true, JSON.stringify(checked.issues));
    await writeFile(join(out, "workflow.json"), JSON.stringify(draft, null, 2));
    return {
      workflowId,
      revision,
      nodes: draft.draft.nodes.length,
      validation: checked.valid,
      repeatedPatchDoesNotDuplicate: true,
      staleCasRejected: true,
    };
  });

  await stage("deterministic_generation_reports_missing_fixtures", async () => {
    const generated = await tool("workflow_test_generate", {
      workflowId,
      expectedRevision: revision,
      strategy: "deterministic",
      idempotencyKey: "deterministic",
    });
    assert.ok(generated.caseCount > 1 && generated.gaps.length > 0);
    const running = await tool("workflow_test_run", {
      suiteId: generated.suiteId,
      expectedSuiteRevision: generated.suiteRevision,
      mode: "mock",
      idempotencyKey: "deterministic-missing",
    });
    const result = await poll(
      "workflow_test_status",
      { testRunId: running.testRunId },
      ["SUCCEEDED", "PARTIAL", "FAILED"],
    );
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.summary.total, generated.caseCount);
    assert.equal(result.summary.failed, 0);
    assert.ok(result.gaps.some((gap) => gap.code === "FIXTURE_MISSING"));
    return {
      suiteId: generated.suiteId,
      generatedCases: generated.caseCount,
      suiteStatus: result.status,
      summary: result.summary,
      missingFixtureIsNotPassed: true,
    };
  });

  const buildCase = (needDetails, id) => {
    const inputs = { orderNo: "DEMO-PLUGIN-01", needDetails },
      summary = "插件完整验收：" + (needDetails ? "需要补充核对" : "无需补查");
    const fixture = {
      synthetic: true,
      environment: "test",
      sentinel: "FLOWHUB_S0_TEST_ONLY_041",
      orderNo: inputs.orderNo,
      message: "合成订单 · 中文与 emoji ✅",
    };
    return {
      id,
      name: summary,
      inputs,
      mockResults: ["lookup", "detail"].map((nodeId) => ({
        nodeId,
        capabilityId: cap.id,
        responseMode: "structured",
        result: { content: [], structuredContent: fixture },
      })),
      agentSubmissions: [{ nodeId: "analysis", payload: { summary } }],
      assertions: [
        { kind: "terminal_state", expected: "SUCCEEDED" },
        { kind: "tool_call_count", nodeId: "lookup", expected: 1 },
        {
          kind: "argument_equals",
          nodeId: "lookup",
          pointer: "/orderNo",
          expected: inputs.orderNo,
        },
        {
          kind: "output_equals",
          nodeId: "lookup",
          pointer: "/message",
          expected: fixture.message,
        },
        { kind: "node_state", nodeId: "analysis", expected: "SUCCEEDED" },
        {
          kind: "output_equals",
          nodeId: "branch",
          pointer: "",
          expected: needDetails,
        },
        { kind: "tool_called", nodeId: "detail", expected: needDetails },
        {
          kind: "tool_call_count",
          nodeId: "detail",
          expected: needDetails ? 1 : 0,
        },
        { kind: "artifact_contains", nodeId: "report", expected: summary },
      ],
      expectedValidationErrors: [],
    };
  };
  goodCases = [
    buildCase(true, "with-details"),
    buildCase(false, "without-details"),
  ];
  async function runCases(cases, key) {
    const suite = await tool("workflow_test_generate", {
      workflowId,
      expectedRevision: revision,
      strategy: "agent_proposed",
      proposedCases: cases,
      idempotencyKey: key + "-generate",
    });
    const running = await tool("workflow_test_run", {
      suiteId: suite.suiteId,
      expectedSuiteRevision: suite.suiteRevision,
      mode: "mock",
      idempotencyKey: key + "-run",
    });
    return {
      suite,
      result: await poll(
        "workflow_test_status",
        { testRunId: running.testRunId },
        ["SUCCEEDED", "FAILED", "PARTIAL"],
      ),
    };
  }
  await stage("agent_proposed_cases_and_isolated_mock_assertions", async () => {
    const before = (await fixtureCalls()).length;
    const { suite, result } = await runCases(goodCases, "positive");
    goodSuite = suite;
    goodTest = result;
    assert.equal(result.status, "SUCCEEDED");
    assert.equal(result.summary.passed, 2);
    assert.ok(
      result.cases.flatMap((row) => row.assertions).every((a) => a.passed),
    );
    assert.ok(
      result.branchCoverage.some((branch) => branch.true && branch.false),
    );
    assert.equal(result.networkCalls, 0);
    assert.equal(result.realSecretReads, 0);
    assert.equal((await fixtureCalls()).length, before);
    await writeFile(
      join(out, "selftest.json"),
      JSON.stringify(result, null, 2),
    );
    return {
      suiteId: suite.suiteId,
      testRunId: result.id,
      summary: result.summary,
      assertionsPassed: result.cases.reduce(
        (sum, c) => sum + c.assertions.length,
        0,
      ),
      branchCoverage: result.branchCoverage,
      networkCalls: result.networkCalls,
      realSecretReads: result.realSecretReads,
      actualFixtureCallsDuringMock: 0,
    };
  });
  await stage("wrong_assertion_fails_even_when_engine_succeeds", async () => {
    const wrong = structuredClone(goodCases[0]);
    wrong.id = "wrong-assertion";
    wrong.assertions.push({
      kind: "output_equals",
      nodeId: "lookup",
      pointer: "/message",
      expected: "DELIBERATELY WRONG",
    });
    const { result } = await runCases([wrong], "negative");
    assert.equal(result.status, "FAILED");
    assert.equal(result.cases[0].executionState, "SUCCEEDED");
    assert.ok(result.cases[0].assertions.some((a) => a.passed === false));
    return {
      expectedStatus: "FAILED",
      actualStatus: result.status,
      engineState: result.cases[0].executionState,
      independentlyRejected: true,
    };
  });
  await stage(
    "draft_change_invalidates_old_suite_and_regeneration_recovers",
    async () => {
      const changed = await tool("workflow_draft_patch", {
        workflowId,
        expectedRevision: revision,
        idempotencyKey: "edit-report-title",
        operations: [
          {
            op: "update_node",
            nodeId: "report",
            changes: { title: "生成经重验的证据报告" },
          },
        ],
      });
      revision = changed.revision;
      const old = await tool("workflow_test_status", {
        testRunId: goodTest.id,
      });
      assert.equal(old.stale, true);
      await tool(
        "workflow_test_run",
        {
          suiteId: goodSuite.suiteId,
          expectedSuiteRevision: goodSuite.suiteRevision,
          mode: "mock",
          idempotencyKey: "stale-suite-rejected",
        },
        "TEST_BASELINE_STALE",
      );
      const { suite, result } = await runCases(goodCases, "regenerated");
      goodSuite = suite;
      goodTest = result;
      assert.equal(result.status, "SUCCEEDED");
      assert.equal(result.stale, false);
      return {
        revision,
        staleSuiteRejected: true,
        regeneratedSuiteId: suite.suiteId,
        testRunId: result.id,
        statusAfterRegeneration: result.status,
      };
    },
  );

  await stage(
    "publish_execute_both_branches_host_checkpoint_and_read_report",
    async () => {
      binding = (await api("/api/v1/bindings")).find(
        (item) => item.id === imported.bindingId,
      );
      await tool("workflow_draft_publish", {
        workflowId,
        expectedRevision: revision,
        version: "1.0.0",
        expectedBindingRevisions: { [binding.id]: binding.revision },
        expectedCapabilityRevisions: { [cap.id]: cap.revision },
        idempotencyKey: "publish-isolated",
      });
      const runs = [];
      for (const needDetails of [true, false]) {
        const started = await tool("workflow_start", {
          workflowId,
          version: "1.0.0",
          mode: "guided",
          inputs: { orderNo: "DEMO-PLUGIN-01", needDetails },
          idempotencyKey: "run-" + needDetails,
        });
        const waiting = await poll(
          "workflow_status",
          { runId: started.runId },
          ["WAITING_AGENT", "FAILED", "BLOCKED", "SUCCEEDED"],
          "state",
        );
        assert.equal(waiting.state, "WAITING_AGENT");
        await tool("workflow_advance", {
          runId: started.runId,
          checkpointId: waiting.checkpoint.id,
          checkpointToken: waiting.checkpoint.token,
          expectedRevision: waiting.revision,
          submission: {
            type: "agent_result",
            payload: {
              summary:
                "插件完整验收：" + (needDetails ? "需要补充核对" : "无需补查"),
            },
          },
          idempotencyKey: "advance-" + needDetails,
        });
        const result = await poll(
          "workflow_status",
          { runId: started.runId },
          ["SUCCEEDED", "FAILED", "BLOCKED"],
          "state",
        );
        assert.equal(result.state, "SUCCEEDED");
        const artifact = result.artifacts.find(
          (a) => a.mimeType === "text/markdown",
        );
        assert.ok(artifact);
        const content = await tool("artifact_read", {
          runId: started.runId,
          artifactId: artifact.id,
          offset: 0,
          maxBytes: 262144,
        });
        assert.ok(content.content.includes("证据索引"));
        assert.ok(content.content.includes("插件完整验收"));
        assert.ok(content.content.includes("订单：DEMO-PLUGIN-01"));
        await writeFile(
          join(
            out,
            needDetails
              ? "report-with-details.md"
              : "report-without-details.md",
          ),
          content.content,
        );
        runs.push({
          runId: started.runId,
          needDetails,
          state: result.state,
          artifactId: artifact.id,
          reportBytes: artifact.byteLength,
        });
      }
      assert.equal(
        (await fixtureCalls()).length,
        4,
        "One explicit verification probe plus two real MCP calls on true branch and one on false branch",
      );
      return {
        workflowId,
        version: "1.0.0",
        runs,
        syntheticProtocolFixtureBusinessCalls: 4,
        modelQualityAcceptance: "UNVERIFIED",
      };
    },
  );
  report.completed = true;
} catch (error) {
  report.failure = error.message;
  process.exitCode = 1;
} finally {
  for (const waiter of pending.values()) clearTimeout(waiter.timer);
  pending.clear();
  lines?.close();
  for (const child of [...children].reverse()) await stop(child);
  report.userConfigAndConnectionUnchanged = (
    await Promise.all(
      protectedHashes.map(
        async (value) => sha(await readFile(value.file)) === value.sha256,
      ),
    )
  ).every(Boolean);
  if (!report.userConfigAndConnectionUnchanged) {
    report.completed = false;
    report.failure =
      "User configuration or connection reference changed during acceptance";
    process.exitCode = 1;
  }
  report.finishedAt = new Date().toISOString();
  report.privateDataRetainedForInspection = true;
  await writeFile(join(out, "result.json"), JSON.stringify(report, null, 2));
  await writeFile(
    join(repo, "artifacts/latest-plugin-e2e.json"),
    JSON.stringify({ output: out, completed: report.completed }, null, 2),
  );
  console.log(
    JSON.stringify(
      {
        completed: report.completed,
        output: out,
        failure: report.failure,
        userConfigAndConnectionUnchanged:
          report.userConfigAndConnectionUnchanged,
      },
      null,
      2,
    ),
  );
}
