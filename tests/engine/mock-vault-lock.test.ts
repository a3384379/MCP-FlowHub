import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import { result } from "../../packages/contracts/src/index.js";
import {
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";
import { type Engine } from "../../packages/workflow-core/src/engine.js";

const inputs = {
  question: "Local Mock vault regression",
  orderNo: "DEMO-1001",
  from: "2026-10-29T00:00:00Z",
  to: "2026-10-29T00:30:00Z",
};

async function wait(engine: Engine, runId: string, expected: string) {
  for (let i = 0; i < 240; i++) {
    const state = engine.status(runId);
    if (state.state === expected) return state;
    if (
      ["FAILED", "BLOCKED", "OUTCOME_UNKNOWN", "CANCELLED"].includes(
        state.state,
      )
    )
      assert.fail(JSON.stringify(state));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("Timed out waiting for " + expected);
}

test("external MOCK_VERIFIED results cannot bypass locked-vault execution protection and never replay unknown reads", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-mock-locked-vault-"));
  const daemon = await startDaemon({ dataDir, port: 0 }),
    engine = daemon.engine;
  let release!: () => void,
    entered!: () => void,
    hold = false;
  const seen = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const transportToken = "6".repeat(64),
    canary = "opaque_mock_vault_canary_784bcc";
  let calls = 0;
  const server = createLocalHttp(() => {
    const s = new McpServer(
      { name: "external-synthetic-vault-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    s.registerTool(
      "synthetic_echo",
      {
        inputSchema: fromJsonSchema({
          type: "object",
          properties: { environment: { type: "string", const: "staging" } },
          required: ["environment"],
          additionalProperties: false,
        }),
        outputSchema: fromJsonSchema({
          type: "object",
          properties: {
            synthetic: { const: true },
            environment: { const: "staging" },
            message: { type: "string" },
          },
          required: ["synthetic", "environment", "message"],
          additionalProperties: false,
        }),
      },
      async () => {
        calls++;
        if (hold) {
          entered();
          await blocked;
        }
        return result({
          synthetic: true,
          environment: "staging",
          message: "opaque diagnostic echo: " + canary,
        });
      },
    );
    return s;
  }, transportToken);
  t.after(async () => {
    release();
    await daemon.close();
    await server.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  await server.listen({ host: "127.0.0.1", port: 0 });
  const base = "http://127.0.0.1:" + daemon.port + "/api/v1";
  const password = "Synthetic-mock-vault-regression-784";
  const setupToken = await readFile(join(dataDir, "admin-setup-token"), "utf8");
  const boot = await fetch(base + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupToken, password }),
  });
  assert.equal(boot.status, 200);
  const cookie = boot.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await boot.json()) as Json).data.csrf;
  const api = async (path: string, body: Json) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const value = (await response.json()) as Json;
    assert.equal(response.status, 200, JSON.stringify(value));
    return value.data;
  };
  const secret = await api("/secrets", {
    label: "local Mock transport token",
    value: transportToken,
  });
  await api("/secrets", { label: "local opaque output canary", value: canary });
  const connection = await api("/connections", {
    name: "External Mock with Vault credential",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint:
      "http://127.0.0.1:" +
      (server.server.address() as { port: number }).port +
      "/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: secret.id,
  });
  const binding = await api("/bindings", {
    name: "External synthetic echo",
    connectionId: connection.id,
    environment: "staging",
    allowedTools: ["synthetic_echo"],
    lockedArguments: { "/environment": "staging" },
    allowedQueryTemplates: [],
    maxRows: 100,
    timeoutSeconds: 5,
  });
  const verified = await api("/bindings/" + binding.id + "/verify", {
    probe: {
      toolName: "synthetic_echo",
      arguments: { environment: "staging" },
    },
    serverEnforcedReadOnly: true,
    scope: "Synthetic local fixture only",
    expectedEnvironmentPointer: "/environment",
  });
  assert.equal(verified.validationStatus, "MOCK_VERIFIED");
  assert.equal(verified.simulationOnly, true);
  const w = structuredClone(
    engine.repo.get("workflows", "incident-staging").draft,
  ) as Workflow;
  w.workflowId = "external-mock-vault-lock";
  w.mode = "auto";
  w.bindings = { log: verified.id };
  w.nodes = [
    { id: "input", title: "Input", type: "input", config: {} },
    {
      id: "read",
      title: "Synthetic read",
      type: "mcp_tool",
      config: {
        bindingKey: "log",
        toolName: "synthetic_echo",
        toolSchemaHash: engine.repo.get("connections", connection.id).tools[0]
          .schemaHash,
        argumentsMappings: {},
      },
    },
    {
      id: "end",
      title: "End",
      type: "end",
      config: {
        resultRef: { ref: { source: "node", nodeId: "read", pointer: "" } },
      },
    },
  ];
  w.edges = [
    { source: "input", target: "read", port: "next" },
    { source: "read", target: "end", port: "next" },
  ];
  engine.saveDraft(w, undefined, {});
  engine.publish(w.workflowId);
  const start = () =>
    engine.start({
      workflowId: w.workflowId,
      version: w.version,
      mode: w.mode,
      inputs,
      idempotencyKey: crypto.randomUUID(),
    });
  hold = true;
  const run = start();
  await seen;
  assert.ok(engine.repo.get("runs", run.runId).dispatch);
  await api("/vault/lock", {});
  release();
  const unknown = await wait(engine, run.runId, "OUTCOME_UNKNOWN");
  assert.equal(unknown.waitingReason, "CREDENTIAL_LOCKED");
  assert.equal(unknown.artifacts.length, 0);
  const persisted = engine.repo.get("runs", run.runId);
  assert.equal(persisted.outputs.read, undefined);
  assert.ok(!JSON.stringify(persisted).includes(canary));
  assert.equal(
    engine.repo.all("artifacts").filter((a) => a.runId === run.runId).length,
    0,
  );
  assert.equal(
    engine.repo.all("attempts").find((a) => a.runId === run.runId).state,
    "OUTCOME_UNKNOWN",
  );
  assert.throws(() => engine.resume(run.runId), { code: "STATE_INVALID" });
  const afterUnknown = calls;
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(calls, afterUnknown);
  engine.vault.unlock(password);
  hold = false;
  const fresh = await wait(engine, start().runId, "SUCCEEDED");
  const artifact = engine.repo
    .all("artifacts")
    .find((a) => a.runId === fresh.runId)!;
  assert.ok(artifact.content.includes(canary));
});

test("built-in synthetic MCP remains usable with a locked vault when no credentials are stored", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-uncredentialed-mock-"));
  const daemon = await startDaemon({ dataDir, port: 0 }),
    engine = daemon.engine;
  t.after(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  assert.equal(engine.vault.locked, true);
  assert.equal(engine.repo.all("secrets").length, 0);
  const w = structuredClone(
    engine.repo.get("workflows", "incident-staging").draft,
  ) as Workflow;
  w.workflowId = "uncredentialed-synthetic-auto";
  w.mode = "auto";
  w.bindings = { log: w.bindings.log! };
  w.nodes = w.nodes.filter((n) => ["input", "log", "end"].includes(n.id));
  w.nodes.find((n) => n.id === "end")!.config.resultRef = {
    ref: { source: "node", nodeId: "log", pointer: "" },
  };
  w.edges = [
    { source: "input", target: "log", port: "next" },
    { source: "log", target: "end", port: "next" },
  ];
  engine.saveDraft(w, undefined, {});
  engine.publish(w.workflowId);
  const run = engine.start({
    workflowId: w.workflowId,
    version: w.version,
    mode: w.mode,
    inputs,
    idempotencyKey: crypto.randomUUID(),
  });
  const completed = await wait(engine, run.runId, "SUCCEEDED");
  assert.equal(completed.artifacts.length, 1);
  assert.equal(engine.repo.get("runs", run.runId).outputs.log.synthetic, true);
});
