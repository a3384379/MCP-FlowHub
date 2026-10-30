import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { Client } from "@modelcontextprotocol/client";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import { result, projectRoot } from "../../packages/contracts/src/index.js";
import {
  hash,
  validate,
  mockSchemas,
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";
import { openStore } from "../../packages/persistence/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";

const inputs = {
  question: "ORIGINAL_INPUT_QUESTION",
  orderNo: "DEMO-1001",
  from: "2026-10-29T00:00:00Z",
  to: "2026-10-29T00:30:00Z",
};

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-audit-regression-"));
  const d = await startDaemon({ dataDir, port: 0 });
  t.after(async () => {
    await d.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + d.port + "/api/v1";
  const setupToken = await readFile(join(dataDir, "admin-setup-token"), "utf8");
  const bootstrap = await fetch(base + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupToken,
      password: "Synthetic-regression-password-724",
    }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await bootstrap.json()) as Json).data.csrf;
  const api = async (
    path: string,
    body: Json,
    method = "POST",
    revision?: number,
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
        ...(revision === undefined ? {} : { "If-Match": String(revision) }),
      },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as Json;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value.data;
  };
  return { d, api, dataDir };
}

async function wait(
  engine: Engine,
  runId: string,
  state: string,
  owner = "execution",
) {
  for (let i = 0; i < 240; i++) {
    const current = engine.status(runId, owner);
    if (current.state === state) return current;
    if (
      ["FAILED", "OUTCOME_UNKNOWN", "BLOCKED", "REJECTED"].includes(
        current.state,
      )
    )
      assert.fail(JSON.stringify(current));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for " + state);
}

function advance(engine: Engine, state: Json, payload: Json) {
  return engine.advance({
    runId: state.runId,
    checkpointId: state.checkpoint.id,
    checkpointToken: state.checkpoint.token,
    expectedRevision: state.revision,
    idempotencyKey: crypto.randomUUID(),
    submission: { type: "agent_result", payload },
  });
}

async function complete(
  engine: Engine,
  w: Workflow,
  runInputs: Json,
  queryNeeded: boolean,
) {
  const started = engine.start({
    workflowId: w.workflowId,
    version: w.version,
    mode: w.mode,
    inputs: runInputs,
    idempotencyKey: crypto.randomUUID(),
  });
  let state = await wait(engine, started.runId, "WAITING_AGENT");
  const log = state.artifacts[0].id;
  advance(engine, state, {
    queryNeeded,
    orderNo: runInputs.orderNo,
    reason: "本机夹具回归测试",
    evidenceRefs: [log],
  });
  if (queryNeeded) {
    state = await wait(engine, started.runId, "WAITING_APPROVAL");
    engine.approve(state.approval.id, {
      decision: "approve",
      expectedRevision: state.revision,
      actionHash: state.approval.actionHash,
      snapshotHash: state.snapshotHash,
    });
  }
  state = await wait(engine, started.runId, "WAITING_AGENT");
  const refs = state.artifacts.map((a: Json) => a.id);
  advance(engine, state, {
    summary: "MAPPED_ANALYSIS_SUMMARY",
    findings: [
      {
        statement: "MAPPED_ANALYSIS_FINDING",
        kind: "confirmed",
        evidenceRefs: [refs.at(-1)],
      },
    ],
    nextActions: ["MAPPED_NEXT_ACTION"],
    evidenceRefs: refs,
  });
  if (w.nodes.some((n) => n.config.kind === "host_skill")) {
    state = await wait(engine, started.runId, "WAITING_AGENT");
    engine.advance({
      runId: state.runId,
      checkpointId: state.checkpoint.id,
      checkpointToken: state.checkpoint.token,
      expectedRevision: state.revision,
      idempotencyKey: crypto.randomUUID(),
      submission: { type: "host_skill_unavailable", useDeclaredFallback: true },
    });
  }
  state = await wait(engine, started.runId, "SUCCEEDED");
  const report = state.artifacts.find(
    (a: Json) => a.mimeType === "text/markdown",
  );
  return {
    state,
    report: engine.readArtifact({ runId: state.runId, artifactId: report.id })
      .content as string,
  };
}

for (const queryNeeded of [true, false])
  test(
    "report mappings survive arbitrary node IDs and " +
      (queryNeeded
        ? "executed DB with declared fallback"
        : "skipped DB with template node"),
    async (t) => {
      const { d } = await fixture(t),
        engine = d.engine;
      const w = structuredClone(
        engine.repo.get("workflows", "incident-staging").draft,
      ) as Workflow;
      w.workflowId = "renamed-" + queryNeeded;
      const names: Record<string, string> = {
        log: "application_logs",
        db: "record_lookup",
        synthesize: "conclusion",
      };
      function rename(value: Json) {
        if (!value || typeof value !== "object") return;
        for (const [key, child] of Object.entries(value))
          if (
            ["nodeId", "actionNodeId", "source", "target", "id"].includes(
              key,
            ) &&
            typeof child === "string" &&
            names[child]
          )
            value[key] = names[child];
          else rename(child);
      }
      rename(w);
      const reportNode = w.nodes.find((n) => n.config.kind === "host_skill")!;
      reportNode.config.inputMappings["/question"] = {
        value: "MAPPED_QUESTION",
      };
      reportNode.config.inputMappings["/from"] = { value: "MAPPED_FROM" };
      reportNode.config.inputMappings["/to"] = { value: "MAPPED_TO" };
      if (!queryNeeded) {
        reportNode.type = "report_template";
        reportNode.config = {
          templateRef: "incident-markdown/v1",
          inputMappings: reportNode.config.inputMappings,
          outputSchema: reportNode.config.outputSchema,
        };
      }
      engine.saveDraft(w, undefined, {});
      engine.publish(w.workflowId);
      const completed = await complete(engine, w, inputs, queryNeeded);
      for (const marker of [
        "MAPPED_QUESTION",
        "MAPPED_FROM",
        "MAPPED_TO",
        "MAPPED_ANALYSIS_SUMMARY",
        "MAPPED_ANALYSIS_FINDING",
        "MAPPED_NEXT_ACTION",
      ])
        assert.ok(completed.report.includes(marker), marker);
      assert.ok(!completed.report.includes(inputs.question));
      const log = completed.state.artifacts.find(
        (a: Json) => a.nodeId === "application_logs",
      );
      assert.ok(
        completed.report
          .split("## 日志证据")[1]!
          .split("## 数据库核对")[0]!
          .includes(log.id),
      );
      assert.equal(
        completed.state.steps.record_lookup,
        queryNeeded ? "SUCCEEDED" : "SKIPPED",
      );
      assert.equal(completed.report.includes("数据库未查询"), !queryNeeded);
      if (queryNeeded)
        assert.ok(completed.report.includes("节点 record_lookup：SUCCEEDED"));
    },
  );

test("standard result refs accept non-synthetic local MCP evidence and retain strict mock provenance", async (t) => {
  const { d, api } = await fixture(t),
    engine = d.engine;
  const runInputs = { ...inputs, orderNo: "ORDER-2026-1042" };
  const nonDemoOrder = { type: "string", minLength: 1, maxLength: 64 };
  const logSchema = {
    type: "object",
    properties: {
      synthetic: { type: "boolean" },
      environment: { type: "string" },
      logs: { type: "array", items: { type: "object" } },
      truncated: { type: "boolean" },
      nextCursor: { type: "null" },
    },
    required: ["synthetic", "environment", "logs", "truncated", "nextCursor"],
    additionalProperties: false,
  };
  const querySchema = {
    type: "object",
    properties: {
      synthetic: { type: "boolean" },
      environment: { type: "string" },
      templateId: { type: "string" },
      rows: { type: "array", items: { type: "object" } },
      rowCount: { type: "integer" },
      truncated: { type: "boolean" },
    },
    required: [
      "synthetic",
      "environment",
      "templateId",
      "rows",
      "rowCount",
      "truncated",
    ],
    additionalProperties: false,
  };
  let synthetic = false,
    malformed = false,
    logCalls = 0,
    queryCalls = 0;
  const logValue = () => ({
    synthetic,
    environment: "staging",
    logs: [
      {
        timestamp: runInputs.from,
        level: "WARN",
        message: "Local protocol fixture only",
        orderNo: runInputs.orderNo,
        ...(malformed ? {} : { traceId: "trace-2026-1042" }),
      },
    ],
    truncated: false,
    nextCursor: null,
  });
  const connectionToken = "8".repeat(64);
  const server = createLocalHttp(() => {
    const s = new McpServer(
      { name: "non-synthetic-shaped-local-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    s.registerTool(
      "fixture_logs",
      {
        inputSchema: fromJsonSchema({
          type: "object",
          properties: {
            question: { type: "string" },
            orderNo: nonDemoOrder,
            from: { type: "string" },
            to: { type: "string" },
            environment: { const: "staging" },
            project: { const: "LOCAL-LOG" },
          },
          required: [
            "question",
            "orderNo",
            "from",
            "to",
            "environment",
            "project",
          ],
          additionalProperties: false,
        }),
        outputSchema: fromJsonSchema(logSchema),
      },
      async () => {
        logCalls++;
        return result(logValue());
      },
    );
    s.registerTool(
      "fixture_query",
      {
        inputSchema: fromJsonSchema({
          type: "object",
          properties: {
            templateId: { type: "string", const: "order-by-number-v1" },
            parameters: {
              type: "object",
              properties: { orderNo: nonDemoOrder },
              required: ["orderNo"],
              additionalProperties: false,
            },
            environment: { const: "staging" },
            connectionId: { const: "LOCAL-DB" },
          },
          required: ["templateId", "parameters", "environment", "connectionId"],
          additionalProperties: false,
        }),
        outputSchema: fromJsonSchema(querySchema),
      },
      async () => {
        queryCalls++;
        return result({
          synthetic: false,
          environment: "staging",
          templateId: "order-by-number-v1",
          rows: [{ orderNo: runInputs.orderNo, ledgerState: "pending" }],
          rowCount: 1,
          truncated: false,
        });
      },
    );
    return s;
  }, connectionToken);
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  const secret = await api("/secrets", {
    label: "Local protocol fixture only",
    value: connectionToken,
  });
  const connection = await api("/connections", {
    name: "Local non-synthetic-shaped fixture",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint:
      "http://127.0.0.1:" +
      (server.server.address() as { port: number }).port +
      "/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: secret.id,
  });
  const bindings: Record<string, string> = {};
  for (const [key, toolName, lockedArguments, allowedQueryTemplates, args] of [
    [
      "log",
      "fixture_logs",
      { "/environment": "staging", "/project": "LOCAL-LOG" },
      [],
      { ...runInputs, environment: "staging", project: "LOCAL-LOG" },
    ],
    [
      "db",
      "fixture_query",
      { "/environment": "staging", "/connectionId": "LOCAL-DB" },
      ["order-by-number-v1"],
      {
        templateId: "order-by-number-v1",
        parameters: { orderNo: runInputs.orderNo },
        environment: "staging",
        connectionId: "LOCAL-DB",
      },
    ],
  ] as [string, string, Json, string[], Json][]) {
    const binding = await api("/bindings", {
      name: "Local " + key,
      connectionId: connection.id,
      environment: "staging",
      allowedTools: [toolName],
      lockedArguments,
      allowedQueryTemplates,
      maxRows: 100,
      timeoutSeconds: 5,
    });
    const verified = await api("/bindings/" + binding.id + "/verify", {
      probe: { toolName, arguments: args },
      serverEnforcedReadOnly: true,
      scope: "Isolated local protocol fixture only; no enterprise access",
      expectedEnvironmentPointer: "/environment",
    });
    assert.equal(verified.validationStatus, "BINDING_VERIFIED");
    assert.equal(verified.simulationOnly, false);
    bindings[key] = binding.id;
  }
  const w = structuredClone(
    engine.repo.get("workflows", "incident-staging").draft,
  ) as Workflow;
  w.workflowId = "runtime-standard-results";
  w.bindings = bindings;
  w.inputSchema.properties.orderNo = nonDemoOrder;
  const plan = w.nodes.find((n) => n.id === "plan")!;
  plan.config.outputSchema.properties.orderNo = nonDemoOrder;
  for (const n of w.nodes.filter((n) => n.type === "mcp_tool")) {
    n.config.toolName = n.id === "log" ? "fixture_logs" : "fixture_query";
    n.config.toolSchemaHash = engine.repo
      .get("connections", connection.id)
      .tools.find((tool: Json) => tool.name === n.config.toolName).schemaHash;
  }
  engine.saveDraft(w, undefined, {});
  engine.publish(w.workflowId);
  const completed = await complete(engine, w, runInputs, true);
  assert.equal(completed.state.steps.db, "SUCCEEDED");
  assert.ok(completed.report.includes("已执行数据库核对"));
  assert.ok(
    logCalls >= 2 && queryCalls >= 2,
    "both probe and execution traverse actual local MCP",
  );
  for (const nodeId of ["log", "db"]) {
    const artifact = engine.repo
      .all("artifacts")
      .find((a) => a.runId === completed.state.runId && a.nodeId === nodeId)!;
    assert.equal(JSON.parse(artifact.content).synthetic, false);
    assert.equal(artifact.verification.synthetic, false);
  }
  // This permissive advertised tool schema allows the engine registry to be
  // tested independently of the downstream tool's own output validation.
  const simple = structuredClone(w);
  simple.workflowId = "runtime-negative-results";
  simple.mode = "auto";
  simple.bindings = { log: bindings.log! };
  simple.nodes = simple.nodes.filter((n) =>
    ["input", "log", "end"].includes(n.id),
  );
  simple.nodes.find((n) => n.id === "end")!.config.resultRef = {
    ref: { source: "node", nodeId: "log", pointer: "" },
  };
  simple.edges = [
    { source: "input", target: "log", port: "next" },
    { source: "log", target: "end", port: "next" },
  ];
  engine.saveDraft(simple, undefined, {});
  engine.publish(simple.workflowId);
  for (const invalid of ["synthetic", "shape"]) {
    synthetic = invalid === "synthetic";
    malformed = invalid === "shape";
    const run = engine.start({
      workflowId: simple.workflowId,
      version: simple.version,
      mode: "auto",
      inputs: runInputs,
      idempotencyKey: crypto.randomUUID(),
    });
    const failed = await wait(engine, run.runId, "FAILED");
    assert.equal(failed.waitingReason, "INPUT_INVALID");
    assert.equal(failed.artifacts.length, 0);
  }
  // Publishing a declared synthetic contract under a real binding fails before dispatch.
  const current = engine.repo.get("connections", connection.id);
  const incompatible = structuredClone(current);
  const tool = incompatible.tools.find(
    (value: Json) => value.name === "fixture_logs",
  );
  tool.outputSchema.properties.synthetic = { const: true };
  tool.schemaHash =
    "sha256:" +
    hash({ inputSchema: tool.inputSchema, outputSchema: tool.outputSchema });
  engine.repo.put("connections", connection.id, incompatible);
  simple.nodes.find((n) => n.id === "log")!.config.toolSchemaHash =
    tool.schemaHash;
  assert.throws(() => engine.validateDraft(simple), { code: "SCHEMA_INVALID" });
  const mockLog = JSON.parse(
    await readFile(join(projectRoot, "examples/mock-log-result.json"), "utf8"),
  );
  validate(
    { ...mockSchemas.$defs.logSearchResult, $defs: mockSchemas.$defs },
    mockLog,
  );
  mockLog.synthetic = false;
  assert.throws(
    () =>
      validate(
        { ...mockSchemas.$defs.logSearchResult, $defs: mockSchemas.$defs },
        mockLog,
      ),
    { code: "INPUT_INVALID" },
  );
  mockLog.synthetic = true;
  mockLog.logs[0].traceId = "ordinary-trace";
  assert.throws(
    () =>
      validate(
        { ...mockSchemas.$defs.logSearchResult, $defs: mockSchemas.$defs },
        mockLog,
      ),
    { code: "INPUT_INVALID" },
  );
});

test("seed is atomic at every write and resumes every legacy partial seed without overwriting unrelated records", async (t) => {
  const { d } = await fixture(t);
  const catalog = structuredClone(
    d.engine.repo.get("connections", "synthetic"),
  );
  const root = await mkdtemp(join(tmpdir(), "flowhub-seed-recovery-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const tables = ["connections", "bindings", "workflows", "versions"] as const;
  const create = (path: string) => {
    const store = openStore(path),
      repo = new Repository(store.db),
      vault = new Vault(repo),
      connectors = new Connectors(repo, vault);
    connectors.discover = async (candidate: Json) => {
      assert.equal(
        store.db.inTransaction,
        false,
        "external discovery precedes SQLite transaction",
      );
      return {
        ...catalog,
        ...candidate,
        tools: catalog.tools,
        verifiedAt: catalog.verifiedAt,
        verifiedSdk: catalog.verifiedSdk,
        verifiedRevision: candidate.revision,
        discovery: catalog.discovery,
      };
    };
    return { store, repo, engine: new Engine(repo, vault, connectors) };
  };
  const snapshots: Json[] = [];
  const baseline = create(join(root, "baseline.sqlite"));
  let writeCount = 0;
  for (const method of ["put", "insert", "audit"]) {
    const original = (baseline.repo as Json)[method].bind(baseline.repo);
    (baseline.repo as Json)[method] = (...args: Json[]) => {
      const value = original(...args);
      writeCount++;
      snapshots.push(
        Object.fromEntries(
          tables.map((table) => [table, baseline.repo.all(table)]),
        ),
      );
      return value;
    };
  }
  await baseline.engine.seed();
  baseline.store.close();
  assert.ok(writeCount >= 10);
  for (let failAt = 1; failAt <= writeCount; failAt++) {
    const path = join(root, "failure-" + failAt + ".sqlite"),
      first = create(path);
    let writes = 0;
    for (const method of ["put", "insert", "audit"]) {
      const original = (first.repo as Json)[method].bind(first.repo);
      (first.repo as Json)[method] = (...args: Json[]) => {
        const value = original(...args);
        if (++writes === failAt)
          throw new Error("injected seed write " + failAt);
        return value;
      };
    }
    await assert.rejects(first.engine.seed(), /injected seed write/);
    for (const table of tables)
      assert.equal(
        first.repo.all(table).length,
        0,
        table + " rollback at " + failAt,
      );
    assert.equal(first.repo.get("settings", "seeded"), undefined);
    assert.equal(
      (
        first.store.db
          .prepare("SELECT COUNT(*) AS n FROM audit_events")
          .get() as { n: number }
      ).n,
      0,
    );
    first.store.close();
    const restarted = create(path);
    await restarted.engine.seed();
    assert.equal(restarted.repo.all("versions").length, 2);
    assert.equal(restarted.repo.all("bindings").length, 4);
    const before = tables.map((table) => restarted.repo.all(table));
    await restarted.engine.seed();
    assert.deepEqual(
      tables.map((table) => restarted.repo.all(table)),
      before,
    );
    restarted.store.close();
    // Recreate old releases' independently committed records at each window.
    const legacy = create(join(root, "legacy-" + failAt + ".sqlite"));
    for (const table of tables)
      for (const record of snapshots[failAt - 1][table])
        legacy.repo.put(table, record.id, record);
    legacy.repo.put("connections", "unrelated", {
      id: "unrelated",
      name: "preserve me",
    });
    await legacy.engine.seed();
    assert.equal(legacy.repo.all("versions").length, 2);
    assert.equal(legacy.repo.all("bindings").length, 4);
    assert.equal(
      legacy.repo.get("connections", "unrelated").name,
      "preserve me",
    );
    for (const environment of ["production", "staging"])
      assert.equal(
        legacy.repo.get("workflows", "incident-" + environment).defaultVersion,
        "1.0.0",
      );
    assert.ok(legacy.repo.get("settings", "seeded"));
    legacy.store.close();
  }
});

function gate() {
  let enter!: () => void, release!: () => void;
  const seen = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { enter, release, seen, blocked };
}

test("dispatch checks asynchronous revocation, cancellation, approval, deadlines and locked-vault result handling; production DB is serialized by connection", async (t) => {
  const { d, api } = await fixture(t),
    engine = d.engine;
  let listGate: ReturnType<typeof gate> | undefined;
  let queryGate: ReturnType<typeof gate> | undefined;
  let readResponseGate: ReturnType<typeof gate> | undefined;
  let sdkPreparationGate: ReturnType<typeof gate> | undefined;
  const originalCall = Client.prototype.callTool;
  Client.prototype.callTool = async function (params, options) {
    if (params.name === "read" && sdkPreparationGate) {
      const held = sdkPreparationGate;
      sdkPreparationGate = undefined;
      held.enter();
      await held.blocked;
    }
    return originalCall.call(this, params, options);
  };
  let readCalls = 0,
    queryCalls = 0,
    active = 0,
    peak = 0;
  const canary = "bare_vault_canary_8eec2199";
  const token = "4".repeat(64);
  const server = createLocalHttp(() => {
    const s = new McpServer(
      { name: "dispatch-local-regression-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    s.registerTool(
      "read",
      {
        inputSchema: fromJsonSchema({
          type: "object",
          properties: { environment: { type: "string", const: "production" } },
          required: ["environment"],
          additionalProperties: false,
        }),
        outputSchema: fromJsonSchema({
          type: "object",
          properties: {
            synthetic: { const: false },
            environment: { const: "production" },
            logs: { type: "array", items: { type: "object" } },
          },
          required: ["synthetic", "environment", "logs"],
          additionalProperties: false,
        }),
      },
      async () => {
        readCalls++;
        if (readResponseGate) {
          readResponseGate.enter();
          await readResponseGate.blocked;
        }
        return result({
          synthetic: false,
          environment: "production",
          logs: [{ message: canary }],
        });
      },
    );
    s.registerTool(
      "query",
      {
        inputSchema: fromJsonSchema({
          type: "object",
          properties: {
            environment: { type: "string", const: "production" },
            templateId: { type: "string", const: "order-by-number-v1" },
            parameters: {
              type: "object",
              properties: { orderNo: { type: "string" } },
              required: ["orderNo"],
              additionalProperties: false,
            },
          },
          required: ["environment", "templateId", "parameters"],
          additionalProperties: false,
        }),
        outputSchema: fromJsonSchema({
          type: "object",
          properties: {
            synthetic: { const: false },
            environment: { const: "production" },
            rows: { type: "array", items: { type: "object" } },
            rowCount: { type: "integer" },
          },
          required: ["synthetic", "environment", "rows", "rowCount"],
          additionalProperties: false,
        }),
      },
      async () => {
        queryCalls++;
        active++;
        peak = Math.max(peak, active);
        try {
          if (queryGate) {
            queryGate.enter();
            await queryGate.blocked;
          }
        } finally {
          active--;
        }
        return result({
          synthetic: false,
          environment: "production",
          rows: [],
          rowCount: 0,
        });
      },
    );
    return s;
  }, token);
  server.addHook("preHandler", async (request) => {
    if ((request.body as Json)?.method === "tools/list" && listGate) {
      const held = listGate;
      listGate = undefined;
      held.enter();
      await held.blocked;
    }
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  const secret = await api("/secrets", {
    label: "local fixture token",
    value: token,
  });
  await api("/secrets", {
    label: "local fixture bare output canary",
    value: canary,
  });
  const connection = await api("/connections", {
    name: "Local dispatch fixture",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint:
      "http://127.0.0.1:" +
      (server.server.address() as { port: number }).port +
      "/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: secret.id,
  });
  async function binding(toolName: string) {
    const record = await api("/bindings", {
      name: "Local " + toolName,
      connectionId: connection.id,
      environment: "production",
      allowedTools: [toolName],
      lockedArguments: { "/environment": "production" },
      allowedQueryTemplates: toolName === "query" ? ["order-by-number-v1"] : [],
      maxRows: 100,
      timeoutSeconds: 5,
    });
    return api("/bindings/" + record.id + "/verify", {
      probe: {
        toolName,
        arguments: {
          environment: "production",
          ...(toolName === "query"
            ? {
                templateId: "order-by-number-v1",
                parameters: { orderNo: inputs.orderNo },
              }
            : {}),
        },
      },
      serverEnforcedReadOnly: true,
      scope: "Local protocol regression fixture; no enterprise service",
      expectedEnvironmentPointer: "/environment",
    });
  }
  let sequence = 0;
  function workflow(b: Json, query = false, seconds = 30) {
    const w = structuredClone(
      engine.repo.get("workflows", "incident-production").draft,
    ) as Workflow;
    w.workflowId = "dispatch-regression-" + ++sequence;
    w.mode = "auto";
    w.bindings = { fixed: b.id };
    const tool = engine.repo
      .get("connections", connection.id)
      .tools.find((value: Json) => value.name === (query ? "query" : "read"));
    const sourceApproval = w.nodes.find((n) => n.type === "approval")!;
    w.nodes = [
      { id: "input", title: "Input", type: "input", config: {} },
      ...(query
        ? [
            {
              id: "approval",
              title: "Approve",
              type: "approval",
              config: {
                ...sourceApproval.config,
                actionNodeId: "call",
                expiresAfterSeconds: seconds,
              },
            },
          ]
        : []),
      {
        id: "call",
        title: "Call",
        type: "mcp_tool",
        config: {
          bindingKey: "fixed",
          toolName: tool.name,
          toolSchemaHash: tool.schemaHash,
          argumentsMappings: query
            ? {
                "/templateId": { value: "order-by-number-v1" },
                "/parameters/orderNo": {
                  ref: { source: "input", pointer: "/orderNo" },
                },
              }
            : {},
        },
      },
      {
        id: "end",
        title: "End",
        type: "end",
        config: {
          resultRef: { ref: { source: "node", nodeId: "call", pointer: "" } },
        },
      },
    ];
    w.edges = query
      ? [
          { source: "input", target: "approval", port: "next" },
          { source: "approval", target: "call", port: "next" },
          { source: "call", target: "end", port: "next" },
        ]
      : [
          { source: "input", target: "call", port: "next" },
          { source: "call", target: "end", port: "next" },
        ];
    return w;
  }
  function publish(w: Workflow) {
    engine.saveDraft(w, undefined, {});
    engine.publish(w.workflowId);
  }
  function start(w: Workflow, owner = "execution") {
    return engine.start(
      {
        workflowId: w.workflowId,
        version: w.version,
        mode: w.mode,
        inputs,
        idempotencyKey: crypto.randomUUID(),
      },
      owner,
    );
  }
  function approve(state: Json) {
    return engine.approve(state.approval.id, {
      decision: "approve",
      expectedRevision: state.revision,
      actionHash: state.approval.actionHash,
      snapshotHash: state.snapshotHash,
    });
  }
  try {
    for (const change of [
      "binding",
      "connection",
      "owner",
      "cancel",
      "budget",
      "sdk",
    ]) {
      const b = await binding("read"),
        w = workflow(b);
      if (change === "budget") {
        w.budgets.maxRunSeconds = 1;
        w.budgets.maxToolSeconds = 1;
      }
      publish(w);
      const owner =
        change === "owner" ? "local-client-revocation" : "execution";
      if (change === "owner")
        engine.repo.put("clients", owner, {
          id: owner,
          revoked: false,
          workflowAllowlist: [w.workflowId],
        });
      const held = gate();
      if (change === "sdk") sdkPreparationGate = held;
      else listGate = held;
      const before = readCalls,
        run = start(w, owner);
      await held.seen;
      const preparing = engine.repo.get("runs", run.runId);
      assert.equal(
        preparing.dispatch,
        undefined,
        "tools/list is not a tool dispatch",
      );
      assert.equal(
        engine.repo.all("attempts").filter((a) => a.runId === run.runId).length,
        0,
      );
      const originalConnection = engine.repo.get("connections", connection.id);
      if (change === "binding" || change === "sdk")
        await api("/bindings/" + b.id, { revoked: true }, "PATCH", b.revision);
      if (change === "connection")
        engine.repo.put("connections", connection.id, {
          ...originalConnection,
          disabled: true,
        });
      if (change === "owner")
        engine.repo.put("clients", owner, {
          id: owner,
          revoked: true,
          workflowAllowlist: [w.workflowId],
        });
      if (change === "cancel") {
        const cancelled = engine.cancel({
          runId: run.runId,
          expectedRevision: preparing.revision,
          idempotencyKey: crypto.randomUUID(),
          reason: "Cancel before actual tool dispatch",
        });
        assert.equal(cancelled.state, "CANCELLED");
        assert.equal(cancelled.inFlight, false);
      }
      if (change === "budget")
        await new Promise((resolve) => setTimeout(resolve, 1150));
      held.release();
      const state = await wait(
        engine,
        run.runId,
        change === "cancel"
          ? "CANCELLED"
          : change === "budget"
            ? "FAILED"
            : "BLOCKED",
        owner,
      );
      await new Promise((resolve) => setTimeout(resolve, 40));
      assert.equal(readCalls, before, change + " must stop tools/call");
      assert.equal(state.artifacts.length, 0);
      assert.equal(engine.repo.get("runs", run.runId).toolCalls, 0);
      if (change === "budget")
        assert.equal(state.waitingReason, "BUDGET_EXCEEDED");
      if (change === "connection")
        engine.repo.put("connections", connection.id, originalConnection);
    }
    const firstBinding = await binding("query"),
      secondBinding = await binding("query");
    const q1 = workflow(firstBinding, true, 600),
      q2 = workflow(secondBinding, true, 600);
    publish(q1);
    publish(q2);
    const pending = [];
    for (const w of [q1, q2, q1])
      pending.push(await wait(engine, start(w).runId, "WAITING_APPROVAL"));
    const heldQueries = gate();
    queryGate = heldQueries;
    const beforeQueries = queryCalls;
    peak = 0;
    for (const state of pending) approve(state);
    await heldQueries.seen;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(
      queryCalls - beforeQueries,
      1,
      "distinct bindings on the same production connection share one slot",
    );
    assert.equal(
      pending.filter((state) => engine.status(state.runId).state === "QUEUED")
        .length,
      2,
    );
    heldQueries.release();
    for (const state of pending) await wait(engine, state.runId, "SUCCEEDED");
    assert.equal(queryCalls - beforeQueries, 3);
    assert.equal(peak, 1);
    queryGate = undefined;
    // Pending approval expiry is visible through status and restart recovery.
    for (const recover of [false, true]) {
      const run = start(q1),
        waiting = await wait(engine, run.runId, "WAITING_APPROVAL");
      const a = engine.repo.get("approvals", waiting.approval.id);
      engine.repo.put("approvals", a.id, { ...a, expiresAt: Date.now() - 1 });
      if (recover) engine.recover();
      const expired = engine.status(run.runId);
      assert.equal(expired.state, "FAILED");
      assert.equal(expired.waitingReason, "CHECKPOINT_EXPIRED");
      assert.equal(expired.approval.state, "EXPIRED");
      const persisted = hash({
        run: engine.repo.get("runs", run.runId),
        approval: expired.approval,
        events: engine.repo.events(run.runId),
      });
      assert.throws(() => approve(expired), { code: "APPROVAL_STALE" });
      assert.equal(
        hash({
          run: engine.repo.get("runs", run.runId),
          approval: engine.repo.get("approvals", a.id),
          events: engine.repo.events(run.runId),
        }),
        persisted,
      );
      assert.throws(() => engine.resume(run.runId), { code: "STATE_INVALID" });
    }
    // Approval can also expire while discovery is in flight after a valid decision.
    const late = await wait(engine, start(q1).runId, "WAITING_APPROVAL");
    const heldApproval = gate();
    listGate = heldApproval;
    const callsBeforeExpiry = queryCalls;
    approve(late);
    await heldApproval.seen;
    const approved = engine.repo.get("approvals", late.approval.id);
    engine.repo.put("approvals", approved.id, {
      ...approved,
      expiresAt: Date.now() - 1,
    });
    heldApproval.release();
    const stale = await wait(engine, late.runId, "FAILED");
    assert.equal(stale.waitingReason, "APPROVAL_STALE");
    assert.equal(queryCalls, callsBeforeExpiry);
    assert.equal(stale.artifacts.length, 0);
    // Once actually dispatched, a vault lock prevents unsafe persistence and replay.
    const realBinding = await binding("read"),
      lockedWorkflow = workflow(realBinding);
    publish(lockedWorkflow);
    const heldResult = gate();
    readResponseGate = heldResult;
    const lockedRun = start(lockedWorkflow);
    await heldResult.seen;
    assert.ok(engine.repo.get("runs", lockedRun.runId).dispatch);
    engine.vault.lock();
    heldResult.release();
    const unknown = await wait(engine, lockedRun.runId, "OUTCOME_UNKNOWN");
    assert.equal(unknown.artifacts.length, 0);
    assert.equal(
      engine.repo.get("runs", lockedRun.runId).outputs.call,
      undefined,
    );
    assert.equal(
      engine.repo.all("attempts").find((a) => a.runId === lockedRun.runId)
        .state,
      "OUTCOME_UNKNOWN",
    );
    assert.throws(() => engine.resume(lockedRun.runId), {
      code: "STATE_INVALID",
    });
    readResponseGate = undefined;
    engine.vault.unlock("Synthetic-regression-password-724");
  } finally {
    listGate?.release();
    queryGate?.release();
    readResponseGate?.release();
    sdkPreparationGate?.release();
    Client.prototype.callTool = originalCall;
  }
});

test("oversized Agent output is rejected atomically and unused unknown outputSchemaRef is rejected before publication", async (t) => {
  const { d } = await fixture(t),
    engine = d.engine;
  const w = structuredClone(
    engine.repo.get("workflows", "incident-staging").draft,
  ) as Workflow;
  w.workflowId = "agent-output-byte-budget";
  w.bindings = { log: w.bindings.log! };
  const agent = w.nodes.find((n) => n.id === "plan")!;
  agent.config.inputMappings = {
    "/question": { ref: { source: "input", pointer: "/question" } },
  };
  w.nodes = [
    { id: "input", title: "Input", type: "input", config: {} },
    agent,
    {
      id: "end",
      title: "End",
      type: "end",
      config: {
        resultRef: { ref: { source: "node", nodeId: "plan", pointer: "" } },
      },
    },
  ];
  w.edges = [
    { source: "input", target: "plan", port: "next" },
    { source: "plan", target: "end", port: "next" },
  ];
  w.budgets.maxOutputBytes = 1024;
  engine.saveDraft(w, undefined, {});
  engine.publish(w.workflowId);
  const run = engine.start({
    workflowId: w.workflowId,
    version: w.version,
    mode: w.mode,
    inputs,
    idempotencyKey: crypto.randomUUID(),
  });
  const waiting = await wait(engine, run.runId, "WAITING_AGENT");
  const before = engine.repo.get("runs", run.runId),
    beforeEvents = engine.repo.events(run.runId);
  assert.throws(
    () =>
      advance(engine, waiting, {
        queryNeeded: false,
        orderNo: inputs.orderNo,
        reason: "界".repeat(600),
        evidenceRefs: [],
      }),
    { code: "BUDGET_EXCEEDED" },
  );
  assert.deepEqual(engine.repo.get("runs", run.runId), before);
  assert.deepEqual(engine.repo.events(run.runId), beforeEvents);
  assert.equal(engine.repo.all("artifacts").length, 0);
  const payload = {
    queryNeeded: false,
    orderNo: inputs.orderNo,
    reason: "Fits the byte budget",
    evidenceRefs: [],
  };
  advance(engine, waiting, payload);
  await wait(engine, run.runId, "SUCCEEDED");
  const completed = engine.repo.get("runs", run.runId);
  assert.equal(
    completed.totalBytes,
    Buffer.byteLength(JSON.stringify(inputs)) +
      Buffer.byteLength(JSON.stringify(payload)),
  );
  assert.equal(completed.outputBytes, completed.totalBytes);
  assert.equal(completed.artifactBytes, 0);
  const unknown = structuredClone(
    engine.repo.get("workflows", "incident-staging").draft,
  ) as Workflow;
  unknown.workflowId = "unknown-unused-output-ref";
  unknown.mode = "auto";
  unknown.bindings = { log: unknown.bindings.log! };
  unknown.nodes = unknown.nodes.filter((n) =>
    ["input", "log", "end"].includes(n.id),
  );
  unknown.nodes.find((n) => n.id === "log")!.config.outputSchemaRef =
    "flowhub://schemas/unknown/v1";
  unknown.nodes.find((n) => n.id === "end")!.config.resultRef = {
    ref: { source: "input", pointer: "" },
  };
  unknown.edges = [
    { source: "input", target: "log", port: "next" },
    { source: "log", target: "end", port: "next" },
  ];
  engine.saveDraft(unknown, undefined, {});
  assert.throws(() => engine.publish(unknown.workflowId), {
    code: "SCHEMA_INVALID",
  });
  assert.equal(
    engine.repo.get("versions", unknown.workflowId + "@" + unknown.version),
    undefined,
  );
});
