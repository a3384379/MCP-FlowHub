import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import {
  decodeToolResult,
  applyRowBudget,
} from "../../packages/contracts/src/tool-adapter.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { registerAdmin } from "../../packages/admin-api/src/index.js";
import { previewRetention, commitRetention } from "../../packages/persistence/src/retention.js";
import {
  hash,
  REPORT_HEADINGS,
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";

const password = "Synthetic-external-audit-2026";

test("F04 legacy result cleanup does not strand inputs encrypted by the later migration", async (t) => {
  const f = fixture(t), secret = randomBytes(32).toString("hex");
  f.vault.addSecret("synthetic legacy retention", secret); f.publish();
  const started = f.start({ question: secret });
  assert.equal((await settle(f, started.runId)).state, "SUCCEEDED");
  const legacy = f.repo.get("runs", started.runId);
  legacy.updatedAt = new Date(Date.now() - 10 * 86400000).toISOString();
  legacy.resultsExpiredAt = legacy.updatedAt;
  legacy.outputs = {}; delete legacy.operationalOutputs;
  legacy.inputs = { question: secret }; delete legacy.operationalInputs; delete legacy.inputSafetyVersion;
  f.repo.put("runs", legacy.id, legacy);
  f.vault.lock(); f.vault.unlock(password);
  assert.ok(f.repo.get("runs", legacy.id).operationalInputs);
  const preview = previewRetention(f.repo);
  assert.ok(preview.resultRuns.includes(legacy.id));
  assert.equal(commitRetention(f.repo, preview.hash).expiredResultRuns, 1);
  const cleaned = f.repo.get("runs", legacy.id);
  assert.equal(cleaned.operationalInputs, undefined);
  assert.equal(JSON.stringify(cleaned).includes(secret), false);
  assert.throws(() => f.vault.inputs(cleaned), { code: "ARTIFACT_EXPIRED" });
});
function fixture(t: TestContext) {
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo);
  vault.initialize(password);
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  t.after(async () => {
    await engine.close();
    db.close();
  });
  const workflow: Workflow = {
    schemaVersion: "flowhub.workflow/v1",
    workflowId: "external-audit",
    name: "合成审计",
    description: "Synthetic negative and positive controls",
    version: "1.0.0",
    environment: "test",
    mode: "auto",
    tags: [],
    bindings: {},
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string" },
        password: { type: "string" },
        orderNo: { type: "string" },
      },
      required: [],
      additionalProperties: false,
    },
    nodes: [
      { id: "input", title: "Input", type: "input", config: {} },
      {
        id: "end",
        title: "End",
        type: "end",
        config: { resultRef: { ref: { source: "input", pointer: "" } } },
      },
    ],
    edges: [{ source: "input", target: "end", port: "next" }],
    budgets: {
      maxRunSeconds: 30,
      maxToolCalls: 8,
      maxNodeExecutions: 32,
      maxAgentCheckpoints: 5,
      maxOutputBytes: 262144,
      maxRows: 50,
      maxToolSeconds: 5,
      maxRetries: 0,
    },
  };
  const publish = () => {
    engine.saveDraft(workflow, undefined, {});
    return engine.publish(workflow.workflowId);
  };
  const start = (inputs: Json = {}, owner = "execution") =>
    engine.start(
      {
        workflowId: workflow.workflowId,
        version: workflow.version,
        mode: workflow.mode,
        inputs,
        idempotencyKey: randomUUID(),
      },
      owner,
    );
  return { db, repo, vault, engine, workflow, publish, start };
}

async function apiFixture(t: TestContext) {
  const f = fixture(t),
    dir = await mkdtemp(join(tmpdir(), "flowhub-external-audit-"));
  const app = Fastify();
  const { auth } = await registerAdmin(app, f.engine, dir);
  auth.setup(password);
  const session = auth.login(password);
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true });
  });
  const api = (
    url: string,
    payload?: Json,
    method: "GET" | "POST" | "PATCH" = "POST",
    revision?: number,
  ) =>
    app.inject({
      method,
      url: "/api/v1" + url,
      headers: {
        cookie: "flowhub_session=" + session.token,
        "x-csrf-token": session.csrf,
        ...(revision === undefined ? {} : { "if-match": String(revision) }),
      },
      ...(payload === undefined ? {} : { payload }),
    });
  return { ...f, app, api };
}

test("F04 registered literals and sensitive input fields stay absent from persisted and locked status views", async (t) => {
  const f = fixture(t),
    secret = randomBytes(32).toString("hex"),
    order = "DEMO-EXACT-017";
  f.vault.addSecret("synthetic", secret);
  f.publish();
  const started = f.start({
    question: "diagnose " + secret,
    password: secret,
    orderNo: order,
  });
  await f.engine.close();
  const saved = f.repo.get("runs", started.runId);
  assert.equal(JSON.stringify(saved).includes(secret), false);
  assert.equal(saved.inputs.orderNo, order);
  const dir = await mkdtemp(join(tmpdir(), "flowhub-safe-input-backup-"));
  try {
    const backup = join(dir, "safe.sqlite");
    await f.repo.backup(backup);
    assert.equal((await readFile(backup)).includes(Buffer.from(secret)), false);
    const restored = new Database(backup, { readonly: true });
    try {
      const copy = JSON.parse(
        (
          restored
            .prepare("SELECT body FROM runs WHERE id=?")
            .get(started.runId) as { body: string }
        ).body,
      );
      assert.equal(f.vault.inputs(copy).question, "diagnose " + secret);
      assert.equal(f.vault.inputs(copy).orderNo, order);
    } finally {
      restored.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  f.vault.lock();
  assert.equal(
    JSON.stringify(f.engine.status(started.runId)).includes(secret),
    false,
  );
  f.vault.unlock(password);
  f.vault.changePassword(password, password + "-new");
  f.vault.lock();
  f.vault.unlock(password + "-new");
  assert.equal(
    JSON.stringify(f.engine.status(started.runId)).includes(secret),
    false,
  );
});

async function settle(f: ReturnType<typeof fixture>, runId: string) {
  for (let i = 0; i < 200; i++) {
    const state = f.engine.status(runId);
    if (!["QUEUED", "RUNNING"].includes(state.state)) return state;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Synthetic external audit run did not settle");
}
function limitedTool(
  f: ReturnType<typeof fixture>,
  fromAgent = false,
  pointer = "/limit",
) {
  const calls: Json[] = [];
  f.workflow.inputSchema.properties.limit = { type: "integer", minimum: 1 };
  f.workflow.inputSchema.required = ["limit"];
  const inputSchema = {
    type: "object",
    properties: {
      environment: { type: "string", const: "test" },
      limit: { type: "integer", minimum: 1 },
      value: { type: "string" },
    },
    required: ["environment", "limit"],
    additionalProperties: false,
  };
  const outputSchema = {
    type: "object",
    properties: {
      environment: { type: "string" },
      synthetic: { type: "boolean" },
    },
    required: ["environment", "synthetic"],
    additionalProperties: false,
  };
  const schemaHash = "sha256:" + hash({ inputSchema, outputSchema });
  f.repo.insert("connections", "limited", {
    id: "limited",
    revision: 1,
    synthetic: true,
    verifiedSdk: "controlled-fixture",
    verifiedAt: new Date().toISOString(),
    tools: [{ name: "read", inputSchema, outputSchema, schemaHash }],
  });
  f.repo.insert("bindings", "limited", {
    id: "limited",
    revision: 1,
    connectionId: "limited",
    connectionRevision: 1,
    environment: "test",
    simulationOnly: true,
    validationStatus: "MOCK_VERIFIED",
    allowedTools: ["read"],
    lockedArguments: { "/environment": "test" },
    allowedQueryTemplates: [],
    maxRows: 10,
    timeoutSeconds: 5,
    toolAdapters: {
      read: {
        version: 1,
        format: "structured",
        environment: { source: "payload", pointer: "/environment" },
        rowLimit: { argumentPointer: pointer },
      },
    },
  });
  f.workflow.bindings = { data: "limited" };
  f.workflow.nodes.splice(
    1,
    0,
    ...(fromAgent
      ? [
          {
            id: "plan",
            title: "Plan",
            type: "agent_task",
            config: {
              kind: "analysis",
              instructions: "Synthetic limit",
              inputMappings: {},
              outputSchema: {
                type: "object",
                properties: { limit: { type: "integer", minimum: 1 } },
                required: ["limit"],
                additionalProperties: false,
              },
            },
          },
        ]
      : []),
    {
      id: "read",
      title: "Read",
      type: "mcp_tool",
      config: {
        bindingKey: "data",
        toolName: "read",
        toolSchemaHash: schemaHash,
        argumentsMappings: {
          [pointer]: {
            ref: fromAgent
              ? { source: "node", nodeId: "plan", pointer: "/limit" }
              : { source: "input", pointer: "/limit" },
          },
        },
      },
    },
  );
  f.workflow.edges = f.workflow.nodes
    .slice(0, -1)
    .map((node, i) => ({
      source: node.id,
      target: f.workflow.nodes[i + 1]!.id,
      port: "next",
    }));
  if (fromAgent) f.workflow.mode = "guided";
  f.engine.connectors.call = async (_b, _n, args, _timeout, dispatch) => {
    dispatch?.();
    calls.push(structuredClone(args));
    return { environment: "test", synthetic: true };
  };
  return calls;
}

test("F03 input and Agent row limits reject 100 before dispatch and accept the exact effective limit 10", async (t) => {
  for (const agent of [false, true])
    for (const limit of [100, 10])
      await t.test(
        (agent ? "Agent" : "input") + " limit=" + limit,
        async (t) => {
          const f = fixture(t),
            calls = limitedTool(f, agent);
          f.publish();
          const run = f.start({ limit });
          let state = await settle(f, run.runId);
          if (agent) {
            assert.equal(state.state, "WAITING_AGENT");
            f.engine.advance({
              runId: run.runId,
              checkpointId: state.checkpoint.id,
              checkpointToken: state.checkpoint.token,
              expectedRevision: state.revision,
              idempotencyKey: randomUUID(),
              submission: { type: "agent_result", payload: { limit } },
            });
            state = await settle(f, run.runId);
          }
          assert.equal(state.state, limit === 10 ? "SUCCEEDED" : "FAILED");
          assert.equal(calls.length, limit === 10 ? 1 : 0);
          if (calls.length) assert.equal(calls[0].limit, 10);
          else {
            assert.equal(state.waitingReason, "BUDGET_EXCEEDED");
            assert.equal(f.repo.all("attempts").length, 0);
          }
        },
      );
});

test("F04 exact encrypted inputs reach the tool while persisted views remain safe through lock and rotation", async (t) => {
  const f = fixture(t),
    calls = limitedTool(f),
    secret = randomBytes(32).toString("hex");
  f.vault.addSecret("synthetic outbound", secret);
  f.workflow.inputSchema.required.push("question");
  f.workflow.nodes.find((node) => node.id === "read")!.config.argumentsMappings[
    "/value"
  ] = { ref: { source: "input", pointer: "/question" } };
  f.publish();
  const run = f.start({ limit: 10, question: secret });
  assert.equal((await settle(f, run.runId)).state, "SUCCEEDED");
  assert.equal(calls[0].value, secret);
  assert.equal(
    JSON.stringify(f.repo.get("runs", run.runId)).includes(secret),
    false,
  );
  f.vault.lock();
  assert.equal(
    JSON.stringify(f.engine.status(run.runId)).includes(secret),
    false,
  );
  f.vault.unlock(password);
  f.vault.changePassword(password, password + "-rotated");
  assert.equal(f.vault.inputs(f.repo.get("runs", run.runId)).question, secret);
});

test("F06 invalid fallback leaves its checkpoint and artifacts unchanged, and a valid host report can be resubmitted", async (t) => {
  const f = fixture(t);
  f.workflow.mode = "guided";
  f.workflow.nodes.splice(1, 0, {
    id: "report",
    title: "Report",
    type: "agent_task",
    config: {
      kind: "host_skill",
      skillRef: "incident-report",
      instructions: "Synthetic report",
      inputMappings: {},
      reportContractRef: "incident-report/v1",
      fallbackTemplateRef: "incident-markdown/v1",
      outputSchema: {
        type: "object",
        properties: {
          reportMarkdown: { type: "string", minLength: 1, maxLength: 500 },
          evidenceRefs: { type: "array", items: { type: "string" } },
        },
        required: ["reportMarkdown", "evidenceRefs"],
        additionalProperties: false,
      },
    },
  });
  f.workflow.edges = [
    { source: "input", target: "report", port: "next" },
    { source: "report", target: "end", port: "next" },
  ];
  f.publish();
  const run = f.start();
  const before = await settle(f, run.runId);
  const request = (submission: Json) => ({
    runId: run.runId,
    checkpointId: before.checkpoint.id,
    checkpointToken: before.checkpoint.token,
    expectedRevision: before.revision,
    idempotencyKey: randomUUID(),
    submission,
  });
  assert.throws(
    () =>
      f.engine.advance(
        request({ type: "host_skill_unavailable", useDeclaredFallback: false }),
      ),
    { code: "HOST_SKILL_UNAVAILABLE" },
  );
  assert.throws(
    () =>
      f.engine.advance(
        request({ type: "host_skill_unavailable", useDeclaredFallback: true }),
      ),
    { code: "INPUT_INVALID" },
  );
  const unchanged = f.engine.status(run.runId);
  assert.equal(unchanged.state, "WAITING_AGENT");
  assert.equal(unchanged.revision, before.revision);
  assert.equal(unchanged.checkpoint.token, before.checkpoint.token);
  assert.equal(f.repo.all("artifacts").length, 0);
  const markdown = REPORT_HEADINGS.map(
    (heading) => "## " + heading + "\n\n无证据。",
  ).join("\n\n");
  f.engine.advance(
    request({
      type: "agent_result",
      payload: { reportMarkdown: markdown, evidenceRefs: [] },
    }),
  );
  assert.equal((await settle(f, run.runId)).state, "SUCCEEDED");
  assert.equal(f.repo.all("artifacts").length, 2);
  for (const artifact of f.repo.all("artifacts"))
    assert.equal(artifact.verification.skillExecution, "host_reported");
});

test("F03 approval summary, action hash and sent parameters agree; post-approval parameter changes dispatch zero calls", async (t) => {
  for (const changed of [false, true])
    await t.test(changed ? "changed" : "unchanged", async (t) => {
      const f = fixture(t),
        calls = limitedTool(f);
      f.workflow.nodes.splice(1, 0, {
        id: "approval",
        title: "Approval",
        type: "approval",
        config: {
          actionNodeId: "read",
          summary: "Synthetic exact limit",
          approvalChannel: "admin_ui",
          bindToResolvedArguments: true,
          invalidateOnArgumentChange: true,
          expiresAfterSeconds: 600,
        },
      });
      f.workflow.edges = f.workflow.nodes
        .slice(0, -1)
        .map((node, i) => ({
          source: node.id,
          target: f.workflow.nodes[i + 1]!.id,
          port: "next",
        }));
      f.publish();
      const run = f.start({ limit: 10 });
      let state = await settle(f, run.runId);
      assert.equal(state.state, "WAITING_APPROVAL");
      assert.equal(state.approval.action.maxRows, 10);
      assert.equal(state.approval.arguments.limit, 10);
      assert.equal(
        state.approval.actionHash,
        hash({
          snapshotHash: state.snapshotHash,
          nodeId: "read",
          args: { environment: "test", limit: 10 },
        }),
      );
      f.engine.approve(state.approval.id, {
        decision: "approve",
        expectedRevision: state.revision,
        actionHash: state.approval.actionHash,
        snapshotHash: state.snapshotHash,
      });
      if (changed) {
        const record = f.repo.get("runs", run.runId);
        record.inputs.limit = 9;
        f.repo.put("runs", record.id, record);
      }
      state = await settle(f, run.runId);
      assert.equal(state.state, changed ? "FAILED" : "SUCCEEDED");
      assert.equal(calls.length, changed ? 0 : 1);
      if (!changed)
        assert.deepEqual(calls[0], { environment: "test", limit: 10 });
    });
  assert.throws(
    () =>
      applyRowBudget(
        { environment: "production", simulationOnly: false, maxRows: 10 },
        "read",
        {},
        50,
      ),
    { code: "ROW_LIMIT_UNVERIFIED" },
  );
  assert.throws(
    () =>
      applyRowBudget(
        {
          environment: "production",
          simulationOnly: false,
          maxRows: 10,
          verification: { serverMaxRows: 10 },
          toolAdapters: {
            read: {
              version: 1,
              format: "structured",
              environment: { source: "payload", pointer: "/environment" },
              rowLimit: {
                serverMaxRows: 10,
                attestation: "Synthetic controlled fixture",
              },
            },
          },
        },
        "read",
        {},
        9,
      ),
    { code: "ROW_LIMIT_UNVERIFIED" },
  );
});

test("F06 incompatible declared fallback is rejected before publication", (t) => {
  const f = fixture(t);
  f.workflow.mode = "guided";
  f.workflow.nodes.splice(1, 0, {
    id: "report",
    title: "Report",
    type: "agent_task",
    config: {
      kind: "host_skill",
      skillRef: "incident-report",
      instructions: "Synthetic report",
      inputMappings: {},
      reportContractRef: "incident-report/v1",
      fallbackTemplateRef: "incident-markdown/v1",
      outputSchema: {
        type: "object",
        properties: {
          reportMarkdown: { type: "string" },
          evidenceRefs: { type: "array", items: { type: "string" } },
          reportFlavor: { type: "string" },
        },
        required: ["reportMarkdown", "evidenceRefs", "reportFlavor"],
        additionalProperties: false,
      },
    },
  });
  f.workflow.edges = [
    { source: "input", target: "report", port: "next" },
    { source: "report", target: "end", port: "next" },
  ];
  assert.throws(() => f.publish(), { code: "TEMPLATE_INVALID" });
  assert.equal(f.repo.all("versions").length, 0);
});

test("F08 connection creation rejects query and command credentials without storing them", async (t) => {
  const f = await apiFixture(t),
    secret = randomBytes(24).toString("hex");
  for (const key of ["api_key", "API%5FKEY", "access_token", "password"]) {
    const r = await f.api("/connections", {
      name: "Synthetic",
      transport: "streamable_http",
      protocolEra: "modern",
      endpoint: "https://example.invalid/mcp?" + key + "=" + secret,
      allowedHosts: ["example.invalid"],
    });
    assert.equal(r.statusCode, 422, r.body);
    assert.equal(r.json().error.code, "PLAINTEXT_CREDENTIAL_DENIED");
    assert.equal(r.body.includes(secret), false);
  }
  const good = await f.api("/connections", {
    name: "Synthetic",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint: "https://example.invalid/mcp?region=synthetic",
    allowedHosts: ["example.invalid"],
  });
  assert.equal(good.statusCode, 200, good.body);
  const record = good.json().data;
  const patched = await f.api(
    "/connections/" + record.id,
    { endpoint: "https://example.invalid/mcp?token=" + secret },
    "PATCH",
    record.revision,
  );
  assert.equal(patched.statusCode, 422, patched.body);
  const command = await f.api("/connections", {
    name: "Synthetic args",
    transport: "stdio",
    protocolEra: "modern",
    command: process.execPath,
    commandApproved: true,
    args: ["--api-key", secret],
  });
  assert.equal(command.statusCode, 422, command.body);
  assert.equal(
    JSON.stringify(f.repo.all("connections")).includes(secret),
    false,
  );
});

test("F03 a declared argument limit above the effective budget cannot be published", (t) => {
  const f = fixture(t);
  const inputSchema = {
    type: "object",
    properties: {
      environment: { const: "test", type: "string" },
      limit: { type: "integer", minimum: 1 },
    },
    required: ["environment", "limit"],
    additionalProperties: false,
  };
  const outputSchema = { type: "object", properties: {} },
    schemaHash = "sha256:" + hash({ inputSchema, outputSchema });
  f.repo.insert("connections", "c", {
    id: "c",
    revision: 1,
    synthetic: true,
    tools: [{ name: "read", inputSchema, outputSchema, schemaHash }],
  });
  f.repo.insert("bindings", "b", {
    id: "b",
    revision: 1,
    connectionId: "c",
    connectionRevision: 1,
    environment: "test",
    simulationOnly: true,
    validationStatus: "MOCK_VERIFIED",
    allowedTools: ["read"],
    lockedArguments: { "/environment": "test" },
    allowedQueryTemplates: [],
    maxRows: 10,
    timeoutSeconds: 5,
    toolAdapters: {
      read: {
        version: 1,
        format: "structured",
        environment: { source: "payload", pointer: "/environment" },
        rowLimit: { argumentPointer: "/limit" },
      },
    },
  });
  f.workflow.bindings = { data: "b" };
  f.workflow.nodes.splice(1, 0, {
    id: "read",
    title: "Read",
    type: "mcp_tool",
    config: {
      bindingKey: "data",
      toolName: "read",
      toolSchemaHash: schemaHash,
      argumentsMappings: { "/limit": { value: 100 } },
    },
  });
  f.workflow.edges = [
    { source: "input", target: "read", port: "next" },
    { source: "read", target: "end", port: "next" },
  ];
  assert.throws(() => f.publish(), { code: "BUDGET_EXCEEDED" });
});

test("F02 official SDK loopback supports explicit structured, bare and single text-JSON contracts", async (t) => {
  const f = await apiFixture(t),
    transportToken = randomBytes(32).toString("hex");
  const credential = f.vault.addSecret("loopback only", transportToken);
  let failure = "",
    calls = 0;
  const object = (properties: Json) => ({
    type: "object",
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  });
  const schemas: Json = {
    sentinel: object({
      environment: { type: "string" },
      rows: { type: "array", items: { type: "integer" } },
      rowCount: { type: "integer" },
    }),
    bare: object({
      rows: { type: "array", items: { type: "integer" } },
      rowCount: { type: "integer" },
    }),
  };
  const downstream = createLocalHttp(() => {
    const server = new McpServer(
      { name: "synthetic-result-adapters", version: "1" },
      { capabilities: { tools: {} } },
    );
    for (const name of ["sentinel", "bare", "text"])
      server.registerTool(
        name,
        {
          description: "Controlled local synthetic SDK contract",
          inputSchema: fromJsonSchema<Json>(
            object({
              resource: { type: "string" },
              limit: { type: "integer", minimum: 1 },
            }),
          ),
          ...(name === "text"
            ? {}
            : { outputSchema: fromJsonSchema(schemas[name]) }),
        },
        async (args) => {
          calls++;
          assert.equal(args.resource, "SYNTHETIC_FIXED");
          assert.ok(args.limit <= 10);
          const value = {
            ...(name === "bare"
              ? {}
              : {
                  environment: failure === "environment" ? "staging" : "test",
                }),
            rows: [1],
            rowCount: 1,
          };
          if (failure === "tool")
            return {
              isError: true,
              content: [{ type: "text" as const, text: "Synthetic error" }],
            };
          if (name !== "text") return { content: [], structuredContent: value };
          const text =
            failure === "json"
              ? "{invalid"
              : failure === "large"
                ? "x".repeat(270000)
                : JSON.stringify(value);
          return {
            content:
              failure === "blocks"
                ? [
                    { type: "text" as const, text },
                    { type: "text" as const, text },
                  ]
                : [{ type: "text" as const, text }],
          };
        },
      );
    return server;
  }, transportToken);
  await downstream.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => downstream.close());
  const port = (downstream.server.address() as { port: number }).port;
  const created = await f.api("/connections", {
    name: "Local SDK",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint: "http://127.0.0.1:" + port + "/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: credential.id,
  });
  assert.equal(created.statusCode, 200, created.body);
  const connectionId = created.json().data.id;
  const sync = await f.api("/connections/" + connectionId + "/sync-tools", {});
  assert.equal(sync.statusCode, 200, sync.body);
  for (const name of ["sentinel", "bare", "text"]) {
    const adapter: Json = {
      version: 1,
      format: name === "text" ? "text_json" : "structured",
      environment:
        name === "bare"
          ? { source: "binding" }
          : { source: "payload", pointer: "/environment" },
      rowLimit: { argumentPointer: "/limit" },
      ...(name === "text" ? { payloadSchema: schemas.sentinel } : {}),
    };
    const binding = await f.api("/bindings", {
      name: "Local " + name,
      connectionId,
      environment: "test",
      allowedTools: [name],
      lockedArguments: { "/resource": "SYNTHETIC_FIXED" },
      allowedQueryTemplates: [],
      maxRows: 10,
      timeoutSeconds: 5,
      toolAdapters: { [name]: adapter },
    });
    assert.equal(binding.statusCode, 200, binding.body);
    const verified = await f.api(
      "/bindings/" + binding.json().data.id + "/verify",
      {
        probe: {
          toolName: name,
          arguments: { resource: "SYNTHETIC_FIXED", limit: 10 },
        },
        serverEnforcedReadOnly: true,
        scope: "Controlled synthetic local server, no enterprise validation",
        expectedEnvironmentPointer: "/environment",
        ...(name === "bare"
          ? {
              sourceAttestation: {
                serviceIdentity: "local synthetic SDK service",
                accountScope: "synthetic readonly fixture",
                resourceScope: "SYNTHETIC_FIXED",
              },
            }
          : {}),
      },
    );
    assert.equal(verified.statusCode, 200, verified.body);
    const b = verified.json().data;
    const tool = f.repo
      .get("connections", connectionId)
      .tools.find((tool: Json) => tool.name === name);
    const node = {
      config: { toolName: name, toolSchemaHash: tool.schemaHash },
    };
    const out = await f.engine.connectors.call(
      b,
      node,
      { resource: "SYNTHETIC_FIXED", limit: 10 },
      5000,
    );
    assert.deepEqual(out.rows, [1]);
    assert.equal(
      Object.hasOwn(out, "environment"),
      name !== "bare",
      "adapter must not fabricate environment payload fields",
    );
    if (name === "text")
      for (const [kind, code] of [
        ["json", "OUTPUT_INVALID"],
        ["large", "OUTPUT_INVALID"],
        ["blocks", "OUTPUT_INVALID"],
        ["environment", "ENVIRONMENT_MISMATCH"],
        ["tool", "TOOL_FAILED"],
      ]) {
        failure = kind!;
        await assert.rejects(
          () =>
            f.engine.connectors.call(
              b,
              node,
              { resource: "SYNTHETIC_FIXED", limit: 10 },
              5000,
            ),
          { code },
        );
        failure = "";
      }
  }
  assert.equal(calls, 11);
  assert.throws(
    () =>
      decodeToolResult(
        {
          environment: "production",
          toolAdapters: {
            bare: {
              version: 1,
              format: "structured",
              environment: { source: "binding" },
            },
          },
        },
        { name: "bare", outputSchema: schemas.bare },
        { structuredContent: { rows: [], rowCount: 0 } },
      ),
    { code: "BINDING_UNVERIFIED" },
  );
});

test("F04 legacy inputs are withheld while locked, then encrypted without losing exact parameters", async (t) => {
  const f = fixture(t),
    secret = randomBytes(32).toString("hex");
  f.vault.addSecret("synthetic", secret);
  f.publish();
  const started = f.start({ orderNo: "DEMO-PRESERVED" });
  await f.engine.close();
  const legacy = f.repo.get("runs", started.runId);
  delete legacy.inputSafetyVersion;
  legacy.inputs.question = secret;
  f.repo.put("runs", legacy.id, legacy);
  f.vault.lock();
  assert.equal(
    JSON.stringify(f.engine.status(legacy.id)).includes(secret),
    false,
  );
  f.vault.unlock(password);
  const migrated = f.repo.get("runs", legacy.id);
  assert.equal(JSON.stringify(migrated).includes(secret), false);
  assert.equal(f.vault.inputs(migrated).question, secret);
  assert.equal(f.vault.inputs(migrated).orderNo, "DEMO-PRESERVED");
});

test("F08 legacy credential URLs are withheld and encrypted at unlock, retaining a recoverable local copy", async (t) => {
  const f = await apiFixture(t),
    secret = randomBytes(24).toString("hex");
  f.repo.insert("connections", "legacy", {
    id: "legacy",
    name: "Synthetic legacy connection",
    revision: 1,
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint: "https://example.invalid/mcp?API_KEY=" + secret,
    args: [],
    allowedHosts: ["example.invalid"],
    tools: [],
  });
  f.vault.lock();
  const before = await f.api("/connections", undefined, "GET");
  assert.equal(before.body.includes(secret), false);
  assert.equal(before.json().data[0].disabled, true);
  f.vault.unlock(password);
  const stored = f.repo.get("connections", "legacy");
  assert.equal(JSON.stringify(stored).includes(secret), false);
  assert.equal(
    JSON.parse(
      f.vault.decrypt(stored.quarantinedConfiguration, "connection:legacy"),
    ).endpoint.includes(secret),
    true,
  );
  const edited = await f.api(
    "/connections/legacy",
    { endpoint: "https://example.invalid/mcp?region=test", disabled: false },
    "PATCH",
    stored.revision,
  );
  assert.equal(edited.statusCode, 200, edited.body);
  assert.equal(
    edited.body.includes("ciphertext"),
    false,
    "API must not return quarantined secrets even as ciphertext",
  );
});
