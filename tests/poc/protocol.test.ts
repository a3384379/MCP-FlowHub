import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer } from "node:http";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import type { Client, CallToolResult } from "@modelcontextprotocol/client";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { readEndpoint } from "../../apps/daemon/src/local-config.js";
import { startMockHttp } from "../../packages/mock-mcps/src/index.js";
import {
  createClient,
  localHttpTransport,
  mockStdioTransport,
  protocolEvidence,
  type Era,
} from "../../packages/mcp-connectors/src/index.js";

const entry = resolve("dist/apps/daemon/src/cli.js");
// Independent expected public surface; do not import the implementation list.
const expected = [
  "artifact_read",
  "workflow_advance",
  "workflow_cancel",
  "workflow_get",
  "workflow_search",
  "workflow_start",
  "workflow_status",
  "host_scan", "host_scan_status", "capability_search", "capability_get", "capability_import",
  "workflow_draft_get", "workflow_draft_create", "workflow_draft_patch", "workflow_draft_validate", "workflow_draft_publish",
  "workflow_test_generate", "workflow_test_run", "workflow_test_status", "project_help_search",
].sort();
const structured = (res: CallToolResult) => {
  assert.ok(res.structuredContent);
  return res.structuredContent as Record<string, unknown>;
};

async function inspectHub(client: Client) {
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), expected);
  for (const tool of tools)
    assert.equal(tool.inputSchema.additionalProperties, false);
  const response = structured(
    await client.callTool({
      name: "workflow_search",
      arguments: { query: "排查", environment: "staging" },
    }),
  );
  const items = response.items as {
    workflowId: string;
    environment: string;
    executable: boolean;
  }[];
  assert.equal(items.length, 1);
  assert.equal(items[0]!.workflowId, "incident-staging");
  assert.equal(items[0]!.environment, "staging");
  assert.equal((items[0] as any).demoOnly, true);
  const detail = structured(
    await client.callTool({
      name: "workflow_get",
      arguments: { workflowId: "incident-staging" },
    }),
  );
  assert.equal(detail.instanceId, response.instanceId);
  assert.equal(detail.demoOnly, true);
  assert.equal(detail.version, "1.0.0");
  // A real call with invalid input must fail; no successful empty response.
  const invalid = await client.callTool({
    name: "workflow_search",
    arguments: { query: "排查", arbitrary: true },
  });
  assert.equal(invalid.isError, true);
  const unavailable = await client.callTool({
    name: "workflow_start",
    arguments: {
      workflowId: "incident-staging",
      version: "1.0.0",
      mode: "guided",
      inputs: {
        question: "合成问题",
        orderNo: "DEMO-1001",
        from: "2026-10-29T00:00:00Z",
        to: "2026-10-29T00:30:00Z",
      },
      idempotencyKey: "rc-negative",
    },
  });
  assert.equal(unavailable.isError, true);
  assert.equal(
    (structured(unavailable).error as { code: string }).code,
    "CREDENTIAL_LOCKED",
  );
  for (const [name, args] of Object.entries({
    workflow_status: { runId: "not-a-run" },
    workflow_cancel: {
      runId: "not-a-run",
      expectedRevision: 1,
      reason: "synthetic",
      idempotencyKey: "cancel",
    },
    workflow_advance: {
      runId: "not-a-run",
      checkpointId: "not-a-checkpoint",
      checkpointToken: "synthetic",
      expectedRevision: 1,
      idempotencyKey: "advance",
      submission: { type: "agent_result", payload: {} },
    },
    artifact_read: { runId: "not-a-run", artifactId: "not-an-artifact" },
  })) {
    const stub = await client.callTool({ name, arguments: args });
    assert.equal(stub.isError, true);
    assert.notEqual(
      (structured(stub).error as { code: string }).code,
      "NOT_IMPLEMENTED",
    );
  }
  const override = await client.callTool({
    name: "workflow_start",
    arguments: {
      workflowId: "incident-staging",
      version: "1.0.0",
      mode: "guided",
      inputs: {},
      idempotencyKey: "s0-override",
      environment: "production",
    },
  });
  assert.equal(override.isError, true);
  return response.instanceId;
}

for (const era of ["modern", "legacy"] as Era[]) {
  for (const transport of ["stdio", "http"]) {
    test(
      `MCP-03/04/13 Mock ${era} × ${transport}: discovery, validated call, Unicode, cleanup`,
      { timeout: 15000 },
      async (t) => {
        const client = createClient(era);
        const token = "a".repeat(64);
        const mock =
          transport === "http" ? await startMockHttp(token) : undefined;
        t.after(async () => {
          await client.close();
          await mock?.close();
        });
        const wire =
          transport === "http"
            ? localHttpTransport(mock!.url, token)
            : mockStdioTransport(entry);
        await client.connect(wire, { timeout: 5000 });
        assert.equal(client.getProtocolEra(), era);
        if (era === "modern")
          assert.equal(client.getNegotiatedProtocolVersion(), "2026-07-28");
        const tools = await client.listTools();
        assert.deepEqual(tools.tools.map((t) => t.name).sort(), [
          "aliyun_log_search",
          "huawei_log_search",
          "query_template",
          "synthetic_order_lookup",
        ]);
        const response = structured(
          await client.callTool({
            name: "synthetic_order_lookup",
            arguments: { orderNo: "DEMO-1001" },
          }),
        );
        assert.equal(response.synthetic, true);
        assert.equal(response.environment, "test");
        assert.equal(response.sentinel, "FLOWHUB_S0_TEST_ONLY_041");
        assert.equal(response.message, "合成订单 · 中文与 emoji ✅");
        const invalid = await client.callTool({
          name: "synthetic_order_lookup",
          arguments: { orderNo: "REAL-ORDER", sql: "forbidden" },
        });
        assert.equal(invalid.isError, true);
        t.diagnostic(JSON.stringify(protocolEvidence(client, transport)));
      },
    );

    test(
      `MCP-01/13 Hub ${era} × ${transport}: 21 fixed tools, one daemon, no fake execution`,
      { timeout: 15000 },
      async (t) => {
        const dataDir = await mkdtemp(join(tmpdir(), "flowhub 中文 path "));
        const daemon = await startDaemon({ dataDir, port: 0 });
        const { url, token } = await readEndpoint(dataDir);
        const client = createClient(era);
        const wire =
          transport === "http"
            ? localHttpTransport(new URL(url), token)
            : new StdioClientTransport({
                command: process.execPath,
                args: [entry, "mcp", "--stdio", "--data-dir", dataDir],
                env: getDefaultEnvironment(),
                stderr: "pipe",
              });
        t.after(async () => {
          await client.close();
          await daemon.close();
          await rm(dataDir, { recursive: true, force: true });
        });
        await client.connect(wire, { timeout: 5000 });
        assert.equal(await inspectHub(client), daemon.instanceId);
        assert.equal(client.getProtocolEra(), era);
        t.diagnostic(JSON.stringify(protocolEvidence(client, transport)));
      },
    );
  }
}

test(
  "ENV-07: two simultaneous bridges observe the same daemon, instance and unchanged database",
  { timeout: 15000 },
  async (t) => {
    const dataDir = await mkdtemp(join(tmpdir(), "flowhub bridges "));
    const daemon = await startDaemon({ dataDir, port: 0 });
    const clients = [createClient("modern"), createClient("legacy")];
    t.after(async () => {
      await Promise.all(clients.map((c) => c.close()));
      await daemon.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const before = await readFile(join(dataDir, "flowhub.sqlite-wal"));
    await Promise.all(
      clients.map(async (client) => {
        await client.connect(
          new StdioClientTransport({
            command: process.execPath,
            args: [entry, "mcp", "--stdio", "--data-dir", dataDir],
            stderr: "pipe",
          }),
          { timeout: 5000 },
        );
        assert.equal(await inspectHub(client), daemon.instanceId);
      }),
    );
    const after = await readFile(join(dataDir, "flowhub.sqlite-wal"));
    assert.deepEqual(after, before);
    assert.equal(daemon.boots, 1);
  },
);

test(
  "MCP-15: HTTP 401/403 never cause legacy negotiation or anonymous retry",
  { timeout: 10000 },
  async (t) => {
    for (const status of [401, 403]) {
      const methods: string[] = [];
      const authorization: (string | undefined)[] = [];
      const server = createServer(async (req, res) => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(Buffer.from(chunk));
        const body = JSON.parse(Buffer.concat(chunks).toString());
        methods.push(body.method);
        authorization.push(req.headers.authorization);
        res.writeHead(status, { "Content-Type": "application/json" });
        res.end("{}");
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      const client = createClient("modern");
      try {
        const port = (server.address() as { port: number }).port;
        await assert.rejects(
          client.connect(
            localHttpTransport(
              new URL(`http://127.0.0.1:${port}/mcp`),
              "synthetic-test-token",
            ),
            { timeout: 2000 },
          ),
        );
        assert.deepEqual(methods, ["server/discover"]);
        assert.deepEqual(authorization, ["Bearer synthetic-test-token"]);
      } finally {
        await client.close();
        await new Promise<void>((r) => server.close(() => r()));
      }
      t.diagnostic(`HTTP ${status}: one modern discovery request, no fallback`);
    }
  },
);
