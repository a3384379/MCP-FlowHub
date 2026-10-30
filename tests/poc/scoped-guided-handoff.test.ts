import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../apps/daemon/src/index.js";
import {
  createClient,
  localHttpTransport,
} from "../../packages/mcp-connectors/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

test("F05 scoped MCP owner completes guided approval/report; other, disallowed and revoked hosts cannot take over", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub-scoped-handoff-")),
    daemon = await startDaemon({ dataDir: dir, port: 0 });
  const clients: ReturnType<typeof createClient>[] = [];
  t.after(async () => {
    for (const client of clients) await client.close();
    await daemon.close();
    await rm(dir, { recursive: true, force: true });
  });
  const base = "http://127.0.0.1:" + daemon.port;
  const setup = await fetch(base + "/api/v1/auth/bootstrap", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      password: "Synthetic-scoped-handoff-2026",
      setupToken: await readFile(join(dir, "admin-setup-token"), "utf8"),
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await setup.json()) as Json).data.csrf;
  const api = async (path: string, payload: Json) => {
    const r = await fetch(base + "/api/v1" + path, {
      method: "POST",
      headers: {
        cookie,
        "x-csrf-token": csrf,
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });
    return { status: r.status, ...((await r.json()) as Json) };
  };
  async function host(label: string, workflowAllowlist = ["incident-staging"]) {
    const record = await api("/clients", { label, workflowAllowlist });
    assert.equal(record.status, 200);
    const client = createClient("modern", label);
    clients.push(client);
    await client.connect(
      localHttpTransport(
        new URL(base + "/mcp"),
        await readFile(record.data.absoluteTokenFile, "utf8"),
      ),
    );
    return {
      id: record.data.id,
      client,
      call: async (name: string, args: Json) => {
        const result = await client.callTool({ name, arguments: args });
        return {
          error: result.isError === true,
          value: result.structuredContent as Json,
        };
      },
    };
  }
  const a = await host("host A"),
    b = await host("host B"),
    denied = await host("disallowed", ["incident-production"]),
    revoked = await host("revoked");
  const inputs = {
    question: "Synthetic guided handoff",
    orderNo: "DEMO-1001",
    from: "2026-10-29T00:00:00Z",
    to: "2026-10-29T00:30:00Z",
  };
  const args = {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: randomUUID(),
  };
  const web = await api("/runs", args);
  assert.equal(web.status, 403);
  assert.equal(web.error.code, "HOST_START_REQUIRED");
  assert.equal(daemon.engine.repo.all("runs").length, 0);
  assert.equal((await denied.call("workflow_start", args)).error, true);
  const started = await a.call("workflow_start", args);
  assert.equal(started.error, false);
  const runId = started.value.runId;
  assert.equal(daemon.engine.repo.get("runs", runId).owner, a.id);
  assert.equal((await b.call("workflow_status", { runId })).error, true);
  const wait = async (state: string) => {
    for (let i = 0; i < 240; i++) {
      const result = await a.call("workflow_status", { runId });
      assert.equal(result.error, false);
      if (result.value.state === state) return result.value;
      assert.ok(
        !["FAILED", "BLOCKED", "OUTCOME_UNKNOWN"].includes(result.value.state),
        JSON.stringify(result.value),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new Error("Scoped guided fixture did not reach " + state);
  };
  const advance = (state: Json, payload: Json) => ({
    runId,
    checkpointId: state.checkpoint.id,
    checkpointToken: state.checkpoint.token,
    expectedRevision: state.revision,
    idempotencyKey: randomUUID(),
    submission: { type: "agent_result", payload },
  });
  let state = await wait("WAITING_AGENT");
  const log = state.artifacts.find(
    (artifact: Json) => artifact.nodeId === "log",
  ).id;
  const plan = advance(state, {
    queryNeeded: true,
    orderNo: inputs.orderNo,
    reason: "Synthetic scope",
    evidenceRefs: [log],
  });
  assert.equal((await b.call("workflow_advance", plan)).error, true);
  assert.equal((await a.call("workflow_advance", plan)).error, false);
  state = await wait("WAITING_APPROVAL");
  const adminAdvance = await api("/runs/" + runId + "/advance", {});
  assert.equal(adminAdvance.status, 403);
  const approved = await api("/approvals/" + state.approval.id + "/decision", {
    decision: "approve",
    actionHash: state.approval.actionHash,
    snapshotHash: state.snapshotHash,
    expectedRevision: state.revision,
  });
  assert.equal(approved.status, 200);
  state = await wait("WAITING_AGENT");
  const db = state.artifacts.find(
    (artifact: Json) => artifact.nodeId === "db",
  ).id;
  assert.equal(
    (
      await a.call(
        "workflow_advance",
        advance(state, {
          summary: "Synthetic conclusion",
          findings: [
            {
              kind: "confirmed",
              statement: "Synthetic record observed",
              evidenceRefs: [db],
            },
          ],
          nextActions: ["Independent human review"],
          evidenceRefs: [log, db],
        }),
      )
    ).error,
    false,
  );
  state = await wait("WAITING_AGENT");
  const fallback = advance(state, {});
  fallback.submission = {
    type: "host_skill_unavailable",
    useDeclaredFallback: true,
  } as Json;
  assert.equal((await a.call("workflow_advance", fallback)).error, false);
  state = await wait("SUCCEEDED");
  const report = state.artifacts.find(
    (artifact: Json) => artifact.mimeType === "text/markdown",
  );
  const artifact = await a.call("artifact_read", {
    runId,
    artifactId: report.id,
    maxBytes: 262144,
  });
  assert.equal(artifact.error, false);
  assert.equal(artifact.value.sha256, hash(artifact.value.content));
  assert.equal(artifact.value.verification.skillExecution, "not_used");
  assert.equal(
    (await b.call("artifact_read", { runId, artifactId: report.id })).error,
    true,
  );
  assert.equal(
    (await api("/clients/" + revoked.id + "/revoke", {})).status,
    200,
  );
  await assert.rejects(() =>
    revoked.client.callTool({
      name: "workflow_start",
      arguments: { ...args, idempotencyKey: randomUUID() },
    }),
  );
});
