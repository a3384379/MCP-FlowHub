import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import { result } from "../../packages/contracts/src/index.js";
import { redact, type Json } from "../../packages/contracts/src/domain.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";

test("credential formats in log, query and Agent strings are sanitized without deleting diagnostic fields", () => {
  const secret = randomBytes(24).toString("base64url");
  const formats = [
    "Authorization: Basic " + secret,
    "Bearer " + secret,
    "postgres://demo:" + secret + "@127.0.0.1/database",
    "mongodb+srv://demo:" + secret + "@localhost/database",
    "password=" + secret,
    'password="' + secret + '"',
    '{"api_key": "' + secret + '"}',
    "client_secret=" + secret,
    "X-Api-Key: " + secret,
    "Cookie: session=" + secret,
    "-----BEGIN PRIVATE KEY-----\n" + secret + "\n-----END PRIVATE KEY-----",
  ];
  for (const message of formats) {
    const clean = redact({
      logs: [{ message }],
      rows: [{ detail: message }],
      summary: message,
    });
    assert.equal(
      JSON.stringify(clean).includes(secret),
      false,
      "credential format survived redaction",
    );
    assert.equal(clean.logs[0].message.includes("[REDACTED"), true);
  }
  const diagnosis = {
    message:
      "password authentication failed; token cache miss; HTTP 503 at 127.0.0.1:9000",
    tokenCount: 42,
    secretRef: "secret_reference_id",
    tokenExpiresAt: "2026-10-29T00:00:00Z",
    password: secret,
    access_token: secret,
  };
  const clean = redact(diagnosis);
  assert.equal(clean.message, diagnosis.message);
  assert.equal(clean.tokenCount, 42);
  assert.equal(clean.secretRef, "[REDACTED]");
  assert.equal(clean.tokenExpiresAt, "[REDACTED]");
  assert.equal(clean.password, "[REDACTED]");
  assert.equal(clean.access_token, "[REDACTED]");
  const aliases = redact({
    authorizationValue: secret,
    passwordValue: secret,
    refreshTokenValue: secret,
    tokenData: { value: secret },
  });
  assert.equal(JSON.stringify(aliases).includes(secret), false);
});

test("long dotted text, URI authorities, assignments and incomplete keys finish under a child-process hard limit", () => {
  const module = new URL(
    "../../packages/contracts/src/domain.js",
    import.meta.url,
  ).href;
  const child = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {redact} from ${JSON.stringify(module)};
    const dotted = 'a.'.repeat(131072);
    if (redact(dotted) !== dotted) process.exit(2);
    if (redact(dotted + '@example.com').includes('@example.com')) process.exit(3);
    if (redact('postgres://' + 'x'.repeat(262144) + '@127.0.0.1/test').includes('x'.repeat(64))) process.exit(4);
    if (redact('password=' + 'x'.repeat(262144)).includes('x'.repeat(64))) process.exit(5);
    if (redact('-----BEGIN PRIVATE KEY-----\\n'.repeat(16384)).includes('BEGIN PRIVATE KEY')) process.exit(6);
    if (redact('normal diagnostics user@example.com.').includes('@')) process.exit(7);
    process.stdout.write('PASS');
  `,
    ],
    { timeout: 3000, maxBuffer: 1024, encoding: "utf8" },
  );
  assert.equal(
    child.status,
    0,
    "redaction child timed out or rejected a sanitization control",
  );
  assert.equal(child.stdout, "PASS");
});

test("vault redaction matches stored literals anywhere without plaintext persistence or cache", (t) => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const repo = new Repository(db),
    vault = new Vault(repo);
  vault.initialize("Synthetic-redaction-password-241");
  const secret = randomBytes(24).toString("base64") + ".*+?";
  const ref = vault.addSecret("synthetic redaction fixture", secret);
  const message = "before<" + secret + ">after";
  const clean = vault.redact({
    arbitrary: message,
    query: [message],
    agent: { summary: message },
    [secret]: "key",
  });
  assert.equal(
    JSON.stringify(clean).includes(secret),
    false,
    "known credential remained in output",
  );
  assert.equal(clean.arbitrary, "before<[REDACTED]>after");
  assert.equal(
    vault
      .redact(encodeURIComponent(secret))
      .includes(encodeURIComponent(secret)),
    false,
  );
  assert.equal(
    JSON.stringify(repo.all("secrets")).includes(secret),
    false,
    "vault stored plaintext",
  );
  vault.lock();
  assert.equal(vault.redact("password=" + secret).includes(secret), false);
  repo.remove("secrets", ref.id);
  vault.unlock("Synthetic-redaction-password-241");
  // Removed credentials must not remain in a process-wide plaintext matcher.
  assert.equal(vault.redact(message) === message, true);
});

test("real MCP results and Agent submissions are redacted before run and artifact persistence", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "flowhub-redaction-"));
  const daemon = await startDaemon({ dataDir: directory, port: 0 });
  t.after(async () => {
    await daemon.close();
    await rm(directory, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + daemon.port + "/api/v1";
  const setup = await fetch(base + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupToken: await readFile(join(directory, "admin-setup-token"), "utf8"),
      password: "Synthetic-redaction-password-241",
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await setup.json()) as Json).data.csrf;
  const api = async (path: string, data?: Json) => {
    const response = await fetch(base + path, {
      method: data === undefined ? "GET" : "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    assert.equal(response.status, 200, "synthetic API request failed: " + path);
    return ((await response.json()) as Json).data;
  };
  const secret = randomBytes(24).toString("base64url"),
    token = randomBytes(32).toString("hex");
  const echo =
    "plain<" +
    secret +
    "> Basic " +
    secret +
    " ; postgres://demo:" +
    secret +
    "@127.0.0.1/test ; password=" +
    secret;
  const inputSchema = {
    type: "object",
    properties: { environment: { const: "production", type: "string" } },
    required: ["environment"],
    additionalProperties: false,
  };
  const outputSchema = {
    type: "object",
    properties: {
      environment: { const: "production", type: "string" },
      logs: {
        type: "array",
        items: {
          type: "object",
          properties: { message: { type: "string" } },
          required: ["message"],
          additionalProperties: false,
        },
      },
    },
    required: ["environment", "logs"],
    additionalProperties: false,
  };
  const server = createLocalHttp(() => {
    const fixture = new McpServer(
      { name: "redaction-synthetic-fixture", version: "1" },
      { capabilities: { tools: {} } },
    );
    fixture.registerTool(
      "read_synthetic",
      {
        inputSchema: fromJsonSchema(inputSchema),
        outputSchema: fromJsonSchema(outputSchema),
      },
      async () =>
        result({ environment: "production", logs: [{ message: echo }] }),
    );
    return fixture;
  }, token);
  await server.listen({ host: "127.0.0.1", port: 0 });
  t.after(() => server.close());
  const port = (server.server.address() as { port: number }).port;
  const transport = await api("/secrets", {
    label: "fixture transport",
    value: token,
  });
  await api("/secrets", { label: "fixture output", value: secret });
  const connection = await api("/connections", {
    name: "synthetic redaction fixture",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint: "http://127.0.0.1:" + port + "/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: transport.id,
  });
  let binding = await api("/bindings", {
    name: "synthetic redaction binding",
    connectionId: connection.id,
    environment: "production",
    allowedTools: ["read_synthetic"],
    lockedArguments: { "/environment": "production" },
    allowedQueryTemplates: [],
    maxRows: 10,
    timeoutSeconds: 5,
  });
  binding = await api("/bindings/" + binding.id + "/verify", {
    probe: {
      toolName: "read_synthetic",
      arguments: { environment: "production" },
    },
    serverEnforcedReadOnly: true,
    scope: "synthetic localhost fixture",
    expectedEnvironmentPointer: "/environment",
  });
  const tool = daemon.engine.repo
    .get("connections", connection.id)
    .tools.find((tool: Json) => tool.name === "read_synthetic");
  const flow = structuredClone(
    daemon.engine.repo.get("workflows", "incident-production").draft,
  );
  flow.workflowId = "redaction-" + randomUUID();
  flow.bindings = { log: binding.id };
  flow.nodes = [
    { id: "input", title: "input", type: "input", config: {} },
    {
      id: "read",
      title: "read",
      type: "mcp_tool",
      config: {
        bindingKey: "log",
        toolName: tool.name,
        toolSchemaHash: tool.schemaHash,
        argumentsMappings: {},
      },
    },
    {
      id: "analysis",
      title: "analysis",
      type: "agent_task",
      config: {
        kind: "analysis",
        instructions: "synthetic fixture",
        inputMappings: {},
        outputSchema: {
          type: "object",
          properties: { summary: { type: "string" } },
          required: ["summary"],
          additionalProperties: false,
        },
      },
    },
    {
      id: "end",
      title: "end",
      type: "end",
      config: {
        resultRef: { ref: { source: "node", nodeId: "analysis", pointer: "" } },
      },
    },
  ];
  flow.edges = [
    { source: "input", target: "read", port: "next" },
    { source: "read", target: "analysis", port: "next" },
    { source: "analysis", target: "end", port: "next" },
  ];
  await api("/workflows", { workflow: flow });
  await api("/workflows/" + flow.workflowId + "/publish", {});
  const started = await api("/runs", {
    workflowId: flow.workflowId,
    version: flow.version,
    mode: flow.mode,
    inputs: flow.inputSchema.examples[0],
    idempotencyKey: randomUUID(),
  });
  const waitFor = async (state: string) => {
    for (let i = 0; i < 200; i++) {
      const run = await api("/runs/" + started.runId);
      if (run.state === state) return run;
      assert.equal(
        ["FAILED", "BLOCKED", "OUTCOME_UNKNOWN"].includes(run.state),
        false,
        "synthetic run failed",
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("synthetic run state timed out");
  };
  const waiting = await waitFor("WAITING_AGENT");
  await api("/runs/" + started.runId + "/advance", {
    runId: started.runId,
    checkpointId: waiting.checkpoint.id,
    checkpointToken: waiting.checkpoint.token,
    expectedRevision: waiting.revision,
    idempotencyKey: randomUUID(),
    submission: { type: "agent_result", payload: { summary: echo } },
  });
  await waitFor("SUCCEEDED");
  const stored = daemon.engine.repo.get("runs", started.runId);
  assert.equal(
    JSON.stringify(stored.outputs).includes(secret),
    false,
    "run outputs leaked a known credential",
  );
  const artifacts = daemon.engine.repo
    .all("artifacts")
    .filter((artifact) => artifact.runId === started.runId);
  assert.equal(artifacts.length > 0, true);
  assert.equal(
    artifacts.some((artifact) => artifact.content.includes(secret)),
    false,
    "artifact content leaked a known credential",
  );
  assert.equal(
    stored.outputs.read.logs[0].message.includes("127.0.0.1/test"),
    true,
  );
  assert.equal(stored.outputs.analysis.summary.includes("[REDACTED]"), true);
});
