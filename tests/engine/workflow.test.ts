import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startDaemon } from "../../apps/daemon/src/index.js";
import {
  createClient,
  localHttpTransport,
} from "../../packages/mcp-connectors/src/index.js";
import { readEndpoint } from "../../apps/daemon/src/local-config.js";
import {
  REPORT_HEADINGS,
  hash,
  type Json,
  HubError,
} from "../../packages/contracts/src/domain.js";
const inputs = {
  question: "DEMO 订单支付状态异常",
  orderNo: "DEMO-1001",
  from: "2026-10-29T00:00:00Z",
  to: "2026-10-29T00:30:00Z",
};
const password = "Synthetic-password-041";
async function fixture(t: Json) {
  const dataDir = await mkdtemp(join(tmpdir(), "FlowHub 完整集成 ")),
    d = await startDaemon({ dataDir, port: 0 });
  const base = "http://127.0.0.1:" + d.port + "/api/v1";
  const setupToken = await readFile(join(dataDir, "admin-setup-token"), "utf8");
  const bootstrap = await fetch(base + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ setupToken, password }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await bootstrap.json()) as Json).data.csrf;
  const api = async (
    path: string,
    body?: Json,
    method = body === undefined ? "GET" : "POST",
  ) => {
    const response = await fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, ...((await response.json()) as Json) };
  };
  const endpoint = await readEndpoint(dataDir),
    client = createClient("modern");
  await client.connect(
    localHttpTransport(new URL(endpoint.url), endpoint.token),
    { timeout: 5000 },
  );
  t.after(async () => {
    await client.close();
    await d.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const tool = async (name: string, args: Json) => {
    const response = await client.callTool({ name, arguments: args });
    if (response.isError)
      throw Object.assign(
        new Error(JSON.stringify(response.structuredContent)),
        response.structuredContent as Json,
      );
    return response.structuredContent as Json;
  };
  return { d, api, tool, dataDir, cookie, csrf, base };
}
async function wait(tool: Json, runId: string, state: string) {
  for (let i = 0; i < 120; i++) {
    const r = await tool("workflow_status", { runId });
    if (r.state === state) return r;
    if (["FAILED", "OUTCOME_UNKNOWN", "BLOCKED", "REJECTED"].includes(r.state))
      throw new Error(JSON.stringify(r));
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("Timed out waiting for " + state);
}
const advance = (r: Json, payload: Json) => ({
  runId: r.runId,
  checkpointId: r.checkpoint.id,
  checkpointToken: r.checkpoint.token,
  expectedRevision: r.revision,
  idempotencyKey: crypto.randomUUID(),
  submission: { type: "agent_result", payload },
});
for (const env of ["production", "staging"])
  test(
    "complete " +
      env +
      " guided MCP → Agent → DB → report chain",
    async (t) => {
      const { d, api, tool } = await fixture(t);
      const start = {
        workflowId: "incident-" + env,
        version: "1.0.0",
        mode: "guided",
        inputs,
        idempotencyKey: "complete-" + env,
      };
      const r = await tool("workflow_start", start);
      assert.equal((await tool("workflow_start", start)).runId, r.runId);
      let state = await wait(tool, r.runId, "WAITING_AGENT");
      const logRef = state.artifacts[0].id;
      const first = advance(state, {
        queryNeeded: true,
        orderNo: inputs.orderNo,
        reason: "合成日志显示回写失败，需要核对",
        evidenceRefs: [logRef],
      });
      await tool("workflow_advance", first);
      await tool("workflow_advance", first);
      state = await wait(tool, r.runId, "WAITING_AGENT");
      assert.equal(state.checkpoint.nodeId, "synthesize");
      const dbRef = state.artifacts.find((a: Json) => a.nodeId === "db").id;
      const db = await tool("artifact_read", {
        runId: r.runId,
        artifactId: dbRef,
      });
      assert.equal(
        JSON.parse(db.content).rows[0].sentinel,
        env === "production"
          ? "PROD_ONLY_SENTINEL_017"
          : "STAGE_ONLY_SENTINEL_029",
      );
      await tool(
        "workflow_advance",
        advance(state, {
          summary: "合成证据核对完成",
          findings: [
            {
              statement: "观察到合成订单记录",
              kind: "confirmed",
              evidenceRefs: [dbRef],
            },
          ],
          nextActions: ["人工复核"],
          evidenceRefs: [logRef, dbRef],
        }),
      );
      state = await wait(tool, r.runId, "WAITING_AGENT");
      assert.equal(state.checkpoint.kind, "host_skill");
      await tool("workflow_advance", {
        ...advance(state, {}),
        submission: {
          type: "host_skill_unavailable",
          useDeclaredFallback: true,
        },
      });
      state = await wait(tool, r.runId, "SUCCEEDED");
      const report = state.artifacts.find(
          (a: Json) => a.mimeType === "text/markdown",
        ),
        bytes = await tool("artifact_read", {
          runId: r.runId,
          artifactId: report.id,
        });
      for (const heading of REPORT_HEADINGS)
        assert.ok(bytes.content.includes("## " + heading));
      assert.equal(bytes.sha256, hash(bytes.content));
      assert.equal(bytes.verification.skillExecution, "not_used");
      assert.equal(bytes.verification.factualReview, "not_performed");
      await mkdir("artifacts/reports", { recursive: true });
      await writeFile(
        "artifacts/reports/incident-" + env + ".md",
        bytes.content,
      );
      await writeFile(
        "artifacts/reports/incident-" + env + ".verification.json",
        JSON.stringify(
          {
            runId: r.runId,
            environment: env,
            sha256: bytes.sha256,
            ...bytes.verification,
          },
          null,
          2,
        ),
      );
      const htmlArtifact = state.artifacts.find(
        (a: Json) => a.mimeType === "text/html",
      );
      const html = await tool("artifact_read", {
        runId: r.runId,
        artifactId: htmlArtifact.id,
        maxBytes: 262144,
      });
      await writeFile(
        "artifacts/reports/incident-" + env + ".html",
        html.content,
      );
    },
  );
test("branch skips DB, evidence/Agent scope cannot be forged, CAS conflicts and cancel", async (t) => {
  const { tool, d } = await fixture(t);
  const r = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "branch",
  });
  const state = await wait(tool, r.runId, "WAITING_AGENT"),
    evidenceRefs = [state.artifacts[0].id];
  await assert.rejects(
    tool(
      "workflow_advance",
      advance(state, {
        queryNeeded: true,
        orderNo: "DEMO-OTHER",
        reason: "bad",
        evidenceRefs,
      }),
    ),
    /SCOPE_OVERRIDE_DENIED/,
  );
  await assert.rejects(
    tool(
      "workflow_advance",
      advance(state, {
        queryNeeded: false,
        orderNo: inputs.orderNo,
        reason: "bad",
        evidenceRefs: ["art_foreign"],
      }),
    ),
    /ARTIFACT_INVALID/,
  );
  const payload = {
    queryNeeded: false,
    orderNo: inputs.orderNo,
    reason: "仅查看日志，明确不检查数据库",
    evidenceRefs,
  };
  const a = advance(state, payload),
    b = advance(state, payload);
  const settled = await Promise.allSettled([
    tool("workflow_advance", a),
    tool("workflow_advance", b),
  ]);
  assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1);
  const next = await wait(tool, r.runId, "WAITING_AGENT");
  assert.equal(next.checkpoint.nodeId, "synthesize");
  assert.equal(
    d.engine.repo
      .all("attempts")
      .filter((a) => a.runId === r.runId && a.nodeId === "db").length,
    0,
  );
  await tool("workflow_cancel", {
    runId: r.runId,
    expectedRevision: next.revision,
    reason: "synthetic cancellation",
    idempotencyKey: "cancel",
  });
  assert.equal(
    (await tool("workflow_status", { runId: r.runId })).state,
    "CANCELLED",
  );
});
test("graph rejects cycles, parallel, environment override, cross-branch dependency", async (t) => {
  const { d } = await fixture(t);
  const base = d.engine.repo.get("workflows", "incident-staging").draft;
  for (const mutate of [
    (w: Json) => w.edges.push({ source: "log", target: "end", port: "next" }),
    (w: Json) => {
      w.edges.find((e: Json) => e.source === "report").target = "log";
    },
    (w: Json) => {
      w.nodes.find((n: Json) => n.id === "log").config.argumentsMappings[
        "/environment"
      ] = { value: "production" };
    },
    (w: Json) => {
      w.nodes.find((n: Json) => n.id === "synthesize").config.inputMappings[
        "/db"
      ] = { ref: { source: "node", nodeId: "db", pointer: "" } };
    },
    (w: Json) => {
      w.nodes.find((n: Json) => n.id === "db").config.toolSchemaHash =
        "sha256:" + "0".repeat(64);
    },
  ]) {
    const w = structuredClone(base);
    mutate(w);
    assert.throws(() => d.engine.validateDraft(w));
  }
});
test("vault restart locks, checkpoints encrypted; run ownership and artifact UTF-8 bounds", async (t) => {
  const { d, tool, dataDir } = await fixture(t);
  const r = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "vault",
  });
  const state = await wait(tool, r.runId, "WAITING_AGENT"),
    token = state.checkpoint.token;
  const stored = d.engine.repo.get("runs", r.runId);
  assert.ok(!JSON.stringify(stored).includes(token));
  assert.equal(stored.checkpoint.tokenHash, hash(token));
  d.engine.vault.lock();
  assert.equal(
    (await tool("workflow_status", { runId: r.runId })).checkpoint.token,
    undefined,
  );
  d.engine.vault.unlock(password);
  assert.equal(
    (await tool("workflow_status", { runId: r.runId })).checkpoint.token,
    token,
  );
  assert.throws(() => d.engine.status(r.runId, "foreign"), /Run unavailable/);
  await assert.rejects(
    tool("artifact_read", {
      runId: r.runId,
      artifactId: state.artifacts[0].id,
      offset: -1,
    }),
    /./,
  );
  await d.close();
  const restarted = await startDaemon({ dataDir, port: 0 });
  try {
    assert.equal(restarted.engine.vault.locked, true);
    assert.equal(restarted.engine.status(r.runId).checkpoint.token, undefined);
    restarted.engine.vault.unlock(password);
    assert.equal(restarted.engine.status(r.runId).checkpoint.token, token);
  } finally {
    await restarted.close();
  }
});
test("admin API rejects CSRF and execution identity; immutable versions and import validation", async (t) => {
  const { d, base, cookie, api } = await fixture(t);
  const denied = await fetch(base + "/vault/lock", {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(denied.status, 403);
  const duplicate = await api("/workflows/incident-staging/publish", {
    expectedRevision: d.engine.repo.get("workflows", "incident-staging").revision,
    expectedBindingRevisions: Object.fromEntries(
      Object.values(
        d.engine.repo.get("workflows", "incident-staging").draft.bindings,
      ).map((ref) => [ref, d.engine.repo.get("bindings", String(ref)).revision]),
    ),
  });
  assert.equal(duplicate.status, 409);
  const invalid = await api("/workflow-imports/preview", {
    workflow: { arbitrary: true },
  });
  assert.equal(invalid.status, 422);
  const original = d.engine.repo.get(
    "versions",
    "incident-staging@1.0.0",
  ).contentHash;
  const w = d.engine.repo.get("workflows", "incident-staging");
  w.draft.name = "draft change";
  d.engine.saveDraft(w.draft, w.revision, w.layout);
  assert.equal(
    d.engine.repo.get("versions", "incident-staging@1.0.0").contentHash,
    original,
  );
});
test("crash recovery never replays dispatched unknown outcome; revoked binding blocks pending action", async (t) => {
  const { d, tool } = await fixture(t);
  const r = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "recover",
  });
  await wait(tool, r.runId, "WAITING_AGENT");
  const record = d.engine.repo.get("runs", r.runId);
  record.state = "RUNNING";
  record.dispatch = "synthetic-dispatch";
  d.engine.repo.put("runs", r.runId, record);
  d.engine.recover();
  assert.equal(d.engine.status(r.runId).state, "OUTCOME_UNKNOWN");
  const binding = d.engine.repo.get("bindings", "huawei-log-staging");
  d.engine.repo.put("bindings", binding.id, {
    ...binding,
    validationStatus: "REVOKED",
  });
  assert.throws(() =>
    d.engine.start({
      workflowId: "incident-staging",
      version: "1.0.0",
      mode: "guided",
      inputs,
      idempotencyKey: "revoked",
    }),
  );
});
test("per-host token is workflow-scoped, cannot read another owner, and revocation takes effect", async (t) => {
  const { d, api, tool, dataDir } = await fixture(t);
  const created = await api("/clients", {
    label: "scoped synthetic host",
    workflowAllowlist: ["incident-staging"],
  });
  assert.equal(created.status, 200);
  const token = await readFile(join(dataDir, created.data.tokenFile), "utf8");
  const client = createClient("modern");
  t.after(() => client.close());
  await client.connect(
    localHttpTransport(new URL("http://127.0.0.1:" + d.port + "/mcp"), token),
    { timeout: 5000 },
  );
  const search = await client.callTool({
    name: "workflow_search",
    arguments: { query: "排查" },
  });
  assert.equal((search.structuredContent as Json).items.length, 1);
  const denied = await client.callTool({
    name: "workflow_get",
    arguments: { workflowId: "incident-production" },
  });
  assert.equal(denied.isError, true);
  const start = await client.callTool({
    name: "workflow_start",
    arguments: {
      workflowId: "incident-staging",
      version: "1.0.0",
      mode: "guided",
      inputs,
      idempotencyKey: "scoped-start",
    },
  });
  assert.equal(start.isError, undefined);
  const runId = (start.structuredContent as Json).runId;
  await assert.rejects(
    tool("workflow_status", { runId }),
    /WORKFLOW_NOT_AVAILABLE/,
  );
  assert.equal((await api("/runs/" + runId)).status, 200);
  assert.equal(
    (await api("/clients/" + created.data.id + "/revoke", {})).status,
    200,
  );
  await assert.rejects(client.listTools());
});
test("vault password rotation rewraps secrets and checkpoint deliveries atomically", async (t) => {
  const { d, tool } = await fixture(t);
  const secret = d.engine.vault.addSecret(
    "synthetic key",
    "test-value-not-real",
  );
  const r = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "rotate",
  });
  const state = await wait(tool, r.runId, "WAITING_AGENT"),
    token = state.checkpoint.token;
  d.engine.vault.changePassword(password, "New-synthetic-password-042");
  d.engine.vault.lock();
  assert.throws(() => d.engine.vault.unlock(password));
  d.engine.vault.unlock("New-synthetic-password-042");
  assert.equal(d.engine.vault.secret(secret.id), "test-value-not-real");
  assert.equal(d.engine.status(r.runId).checkpoint.token, token);
  assert.ok(
    !JSON.stringify(d.engine.repo.all("secrets")).includes(
      "test-value-not-real",
    ),
  );
});
test("deterministic auto flow runs without Agent; duplicate idempotency keys with changed input conflict", async (t) => {
  const { d, tool } = await fixture(t);
  const w = structuredClone(
    d.engine.repo.get("workflows", "incident-staging").draft,
  );
  w.workflowId = "deterministic-log";
  w.name = "确定性日志检查";
  w.mode = "auto";
  w.nodes = w.nodes.filter((n: Json) => ["input", "log", "end"].includes(n.id));
  w.nodes.find((n: Json) => n.id === "end").config.resultRef = {
    ref: { source: "node", nodeId: "log", pointer: "" },
  };
  w.edges = [
    { source: "input", target: "log", port: "next" },
    { source: "log", target: "end", port: "next" },
  ];
  d.engine.saveDraft(w, undefined, {});
  d.engine.publish(w.workflowId);
  const request = {
    workflowId: w.workflowId,
    version: w.version,
    mode: "auto",
    inputs,
    idempotencyKey: "auto-fixed",
  };
  const r = await tool("workflow_start", request);
  await wait(tool, r.runId, "SUCCEEDED");
  await assert.rejects(
    tool("workflow_start", {
      ...request,
      inputs: { ...inputs, question: "different" },
    }),
    /IDEMPOTENCY_CONFLICT/,
  );
});
test("consistent SQLite backup and stopped-daemon restore preserve committed workflows", async (t) => {
  const { d, api, dataDir } = await fixture(t);
  const backup = await api("/backups", {});
  assert.equal(backup.status, 200);
  const { restoreBackup } = await import(
    "../../packages/persistence/src/maintenance.js"
  );
  const path = join(dataDir, "backups", backup.data.filename);
  await assert.rejects(restoreBackup(dataDir, path), /DAEMON_ALREADY_RUNNING/);
  await d.close();
  await restoreBackup(dataDir, path);
  const restarted = await startDaemon({ dataDir, port: 0 });
  try {
    assert.equal(restarted.engine.vault.locked, true);
    assert.equal(restarted.engine.repo.all("workflows").length, 2);
  } finally {
    await restarted.close();
  }
});
test("retention preview/commit never deletes active runs", async (t) => {
  const { d, api, tool } = await fixture(t);
  const r = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "retention",
  });
  await wait(tool, r.runId, "WAITING_AGENT");
  const record = d.engine.repo.get("runs", r.runId);
  record.updatedAt = "2020-01-01T00:00:00Z";
  d.engine.repo.put("runs", record.id, record);
  const preview = await api("/retention/preview", {});
  assert.ok(!preview.data.runs.includes(record.id));
  assert.equal(
    (await api("/retention/commit", { previewHash: preview.data.hash })).status,
    200,
  );
  assert.ok(d.engine.repo.get("runs", record.id));
});
test("report requires actual chapters/bytes, references and bounded UTF-8 reads", async (t) => {
  const { tool } = await fixture(t);
  const r = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "report-negative",
  });
  let state = await wait(tool, r.runId, "WAITING_AGENT");
  const evidenceRefs = [state.artifacts[0].id];
  await tool(
    "workflow_advance",
    advance(state, {
      queryNeeded: false,
      orderNo: inputs.orderNo,
      reason: "仅看日志",
      evidenceRefs,
    }),
  );
  state = await wait(tool, r.runId, "WAITING_AGENT");
  await tool(
    "workflow_advance",
    advance(state, {
      summary: "模拟范围有限",
      findings: [
        { kind: "unknown", statement: "尚无充分证据", evidenceRefs: [] },
      ],
      nextActions: [],
      evidenceRefs,
    }),
  );
  state = await wait(tool, r.runId, "WAITING_AGENT");
  await assert.rejects(
    tool(
      "workflow_advance",
      advance(state, {
        reportMarkdown: "只有路径，没有报告章节",
        evidenceRefs,
      }),
    ),
    /ARTIFACT_INVALID/,
  );
  const indexedEvidence = state.artifacts.find((a: Json) => a.id === evidenceRefs[0]);
  const valid = REPORT_HEADINGS.map(
    (h) => "## " + h + "\n" + (h === "证据索引"
      ? `- ${indexedEvidence.id} / ${indexedEvidence.sha256} / ${indexedEvidence.byteLength} bytes`
      : "合成说明 " + evidenceRefs[0]),
  ).join("\n\n");
  await tool(
    "workflow_advance",
    advance(state, { reportMarkdown: valid, evidenceRefs }),
  );
  state = await wait(tool, r.runId, "SUCCEEDED");
  const markdown = state.artifacts.find(
      (a: Json) => a.mimeType === "text/markdown",
    ),
    html = state.artifacts.find((a: Json) => a.mimeType === "text/html");
  assert.ok(html);
  const content = await tool("artifact_read", {
    runId: r.runId,
    artifactId: markdown.id,
  });
  const bytes = Buffer.from(content.content),
    unicode = bytes.findIndex((v) => v >= 128);
  await assert.rejects(
    tool("artifact_read", {
      runId: r.runId,
      artifactId: markdown.id,
      offset: unicode,
      maxBytes: 1,
    }),
    /INPUT_INVALID/,
  );
  await assert.rejects(
    tool("artifact_read", {
      runId: r.runId,
      artifactId: markdown.id,
      offset: unicode + 1,
      maxBytes: 8,
    }),
    /INPUT_INVALID/,
  );
  assert.equal(content.verification.skillExecution, "host_reported");
  const rendered = await tool("artifact_read", {
    runId: r.runId,
    artifactId: html.id,
  });
  assert.ok(rendered.content.includes("default-src 'none'"));
});
test("100 workflows remain a fixed 21-tool server; opaque search cursors bind to filters", async (t) => {
  const { d, tool, dataDir } = await fixture(t);
  const original = d.engine.repo.get("workflows", "incident-staging").draft;
  const ambiguous = await tool("workflow_search", { query: "查一下数据库" });
  assert.equal(ambiguous.items.length, 2);
  assert.equal(ambiguous.needsEnvironmentConfirmation, true);
  const production = await tool("workflow_search", { query: "生产支付异常" });
  assert.equal(production.items[0].environment, "production");
  for (let i = 0; i < 100; i++) {
    const w = structuredClone(original);
    w.workflowId = "synthetic-" + i;
    w.name = "合成排查 " + i;
    d.engine.saveDraft(w, undefined, {});
    d.engine.publish(w.workflowId);
  }
  const first = await tool("workflow_search", { query: "排查", limit: 50 });
  assert.equal(first.items.length, 50);
  assert.ok(first.nextCursor);
  const second = await tool("workflow_search", {
    query: "排查",
    limit: 50,
    cursor: first.nextCursor,
  });
  assert.equal(second.items.length, 50);
  assert.ok(
    !first.items.some((x: Json) =>
      second.items.some((y: Json) => x.workflowId === y.workflowId),
    ),
  );
  await assert.rejects(
    tool("workflow_search", {
      query: "different",
      limit: 50,
      cursor: first.nextCursor,
    }),
    /INPUT_INVALID/,
  );
  const endpoint = await readEndpoint(dataDir),
    client = createClient("modern");
  try {
    await client.connect(
      localHttpTransport(new URL(endpoint.url), endpoint.token),
    );
    assert.equal((await client.listTools()).tools.length, 21);
  } finally {
    await client.close();
  }
});

test("malformed STDIO closes transport; cached protocol revision and SDK cannot silently survive edits", async (t) => {
  const { d } = await fixture(t);
  d.engine.repo.insert("connections", "polluted", {
    id: "polluted",
    name: "synthetic malformed STDIO",
    transport: "stdio",
    protocolEra: "modern",
    command: process.execPath,
    args: ["-e", 'console.log("not-json");setInterval(()=>{},1000)'],
    commandApproved: true,
    envRefs: {},
    synthetic: false,
    disabled: false,
    revision: 1,
    tools: [],
  });
  await assert.rejects(
    d.engine.connectors.sync("polluted"),
    /MCP connection failed/,
  );
  const cached = d.engine.repo.get("connections", "synthetic");
  await assert.rejects(
    d.engine.connectors.connect({ ...cached, revision: cached.revision + 1 }),
    /expired or changed/,
  );
  await assert.rejects(
    d.engine.connectors.connect({ ...cached, verifiedSdk: "0.0.0" }),
    /expired or changed/,
  );
});

test("publication and checkpoint adversarial regressions", async (t) => {
  const { d, tool, api } = await fixture(t);
  const original = structuredClone(
    d.engine.repo.get("workflows", "incident-staging").draft,
  );
  await t.test(
    "WF-07 stale draft writes cannot replace a newer revision",
    () => {
      const record = d.engine.repo.get("workflows", "incident-staging");
      d.engine.saveDraft(
        { ...record.draft, name: "Latest draft" },
        record.revision,
        record.layout,
      );
      assert.throws(
        () => d.engine.saveDraft(record.draft, record.revision, record.layout),
        /Draft changed/,
      );
    },
  );
  await t.test(
    "WF-10 disabled versions cannot start; history remains",
    async () => {
      const w = d.engine.repo.get("workflows", "incident-production");
      d.engine.repo.put("workflows", w.id, { ...w, enabled: false });
      try {
        await assert.rejects(
          tool("workflow_start", {
            workflowId: w.id,
            version: "1.0.0",
            mode: "guided",
            inputs,
            idempotencyKey: "disabled",
          }),
          /WORKFLOW_NOT_AVAILABLE/,
        );
        assert.ok(d.engine.repo.get("versions", w.id + "@1.0.0"));
      } finally {
        d.engine.repo.put("workflows", w.id, w);
      }
    },
  );
  await t.test(
    "AGT-02 auto cannot silently execute guided Agent tasks",
    async () => {
      await assert.rejects(
        tool("workflow_start", {
          workflowId: "incident-staging",
          version: "1.0.0",
          mode: "auto",
          inputs,
          idempotencyKey: "no-auto-agent",
        }),
        /MODE_NOT_SUPPORTED/,
      );
    },
  );
  const created = await tool("workflow_start", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "adversarial-cp",
  });
  let state = await wait(tool, created.runId, "WAITING_AGENT");
  const evidenceRefs = [state.artifacts[0].id],
    payload = {
      queryNeeded: true,
      orderNo: inputs.orderNo,
      reason: "需要独立审批",
      evidenceRefs,
    };
  await t.test("AGT-05 bad token cannot advance", async () => {
    await assert.rejects(
      tool("workflow_advance", {
        ...advance(state, payload),
        checkpointToken: "bad-token",
      }),
      /CHECKPOINT_EXPIRED/,
    );
    assert.equal(
      (await tool("workflow_status", { runId: created.runId })).revision,
      state.revision,
    );
  });
  await t.test(
    "AGT-06 unauthorized SQL fields do not consume checkpoint",
    async () => {
      await assert.rejects(
        tool(
          "workflow_advance",
          advance(state, { ...payload, sql: "DROP TABLE mock" }),
        ),
        /INPUT_INVALID/,
      );
      assert.equal(
        (await tool("workflow_status", { runId: created.runId })).state,
        "WAITING_AGENT",
      );
    },
  );
  await tool("workflow_advance", advance(state, payload));
  await t.test(
    "SEC-05 externally registered Mock can never become BINDING_VERIFIED",
    async () => {
      const conn = await api("/connections", {
        name: "independently registered synthetic service",
        transport: "stdio",
        protocolEra: "modern",
        command: process.execPath,
        args: [
          join(process.cwd(), "dist/apps/daemon/src/cli.js"),
          "mock",
          "--stdio",
        ],
        commandApproved: true,
      });
      assert.equal(conn.status, 200);
      const binding = await api("/bindings", {
        name: "synthetic provenance check",
        connectionId: conn.data.id,
        environment: "staging",
        allowedTools: ["huawei_log_search"],
        lockedArguments: {
          "/environment": "staging",
          "/project": "DEMO-LOG-STAGING",
        },
        allowedQueryTemplates: [],
        maxRows: 100,
        timeoutSeconds: 30,
      });
      assert.equal(binding.status, 200);
      const verified = await api("/bindings/" + binding.data.id + "/verify", {
        probe: {
          toolName: "huawei_log_search",
          arguments: {
            ...inputs,
            environment: "staging",
            project: "DEMO-LOG-STAGING",
          },
        },
        serverEnforcedReadOnly: true,
        scope: "synthetic test only",
        expectedEnvironmentPointer: "/environment",
      });
      assert.equal(verified.status, 200);
      assert.equal(verified.data.validationStatus, "MOCK_VERIFIED");
      assert.equal(verified.data.simulationOnly, true);
      const w = structuredClone(original);
      w.workflowId = "synthetic-provenance";
      w.bindings.log = binding.data.id;
      d.engine.saveDraft(w, undefined, {});
      const published = d.engine.publish(w.workflowId);
      assert.equal(
        published.snapshot.bindings.find((b: Json) => b.id === binding.data.id)
          .simulationOnly,
        true,
      );
    },
  );
  await t.test(
    "SEC-13 / WF-08 arbitrary code and file nodes cannot be imported",
    async () => {
      const w = structuredClone(original);
      w.workflowId = "bad-import";
      w.nodes[1] = {
        id: "execute",
        title: "forbidden",
        type: "shell",
        config: { command: "echo forbidden" },
      };
      assert.equal(
        (await api("/workflow-imports/preview", { workflow: w })).status,
        422,
      );
    },
  );
  await t.test(
    "SEC-14 server rejects a query interval wider than one day",
    async () => {
      await assert.rejects(
        tool("workflow_start", {
          workflowId: "incident-staging",
          version: "1.0.0",
          mode: "guided",
          inputs: { ...inputs, to: "2026-11-01T00:00:00Z" },
          idempotencyKey: "wide-window",
        }),
        /INPUT_INVALID/,
      );
    },
  );
});

test("Web-created guided run is owned by the selected restricted host and retains revocation/isolation", async (t) => {
  const { d, api, dataDir } = await fixture(t);
  const client = await api("/clients", { label: "Scoped Codex", workflowAllowlist: ["incident-staging"] });
  const owner = client.data.id;
  const host = createClient("modern");
  t.after(() => host.close());
  await host.connect(localHttpTransport(new URL("http://127.0.0.1:" + d.port + "/mcp"),
    await readFile(join(dataDir, client.data.tokenFile), "utf8")));
  const started = await api("/runs", { workflowId: "incident-staging", version: "1.0.0", mode: "guided", inputs,
    clientId: owner, idempotencyKey: crypto.randomUUID() });
  assert.equal(started.status, 200);
  const runId = started.data.runId;
  let state: Json;
  for (let i = 0; i < 200; i++) {
    state = d.engine.status(runId, owner);
    if (state.state === "WAITING_AGENT") break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(state.checkpoint.nodeId, "plan");
  assert.throws(() => d.engine.status(runId), { code: "WORKFLOW_NOT_AVAILABLE" });
  assert.throws(() => d.engine.status(runId, "other-host"), { code: "WORKFLOW_NOT_AVAILABLE" });
  const denied = await api("/runs", { workflowId: "incident-production", version: "1.0.0", mode: "guided", inputs,
    clientId: owner, idempotencyKey: crypto.randomUUID() });
  assert.equal(denied.status, 404);
  const accepted = await host.callTool({ name: "workflow_advance", arguments: advance(state, {
    queryNeeded: false, orderNo: inputs.orderNo, reason: "合成日志已足够", evidenceRefs: [state.artifacts[0].id],
  }) });
  assert.notEqual(accepted.isError, true);
  for (let i = 0; i < 200; i++) {
    state = d.engine.status(runId, owner);
    if (state.checkpoint?.nodeId === "synthesize") break;
    await new Promise(r => setTimeout(r, 20));
  }
  const refs = state.artifacts.map((a: Json) => a.id);
  assert.notEqual((await host.callTool({ name: "workflow_advance", arguments: advance(state, {
    summary: "完整合成分析", findings: [{ statement: "合成日志分析", kind: "hypothesis", evidenceRefs: refs }], nextActions: ["复查"], evidenceRefs: refs,
  }) })).isError, true);
  for (let i = 0; i < 200; i++) {
    state = d.engine.status(runId, owner);
    if (state.checkpoint?.nodeId === "report") break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.notEqual((await host.callTool({ name: "workflow_advance", arguments: {
    ...advance(state, {}), submission: { type: "host_skill_unavailable", useDeclaredFallback: true },
  } })).isError, true);
  for (let i = 0; i < 200; i++) {
    state = d.engine.status(runId, owner);
    if (state.state === "SUCCEEDED") break;
    await new Promise(r => setTimeout(r, 20));
  }
  assert.equal(state.state, "SUCCEEDED");
  await api("/clients/" + owner + "/revoke", {});
  assert.throws(() => d.engine.start({ workflowId: "incident-staging", version: "1.0.0", mode: "guided", inputs,
    idempotencyKey: crypto.randomUUID() }, owner), { code: "WORKFLOW_NOT_AVAILABLE" });
});

test("legacy migration backs up and copies draft/publication; recovery retires waiting runs and preserves history", async (t) => {
  const { d, api, dataDir } = await fixture(t);
  const repo = d.engine.repo, source = repo.get("workflows", "incident-staging");
  const legacy = structuredClone(source.draft);
  legacy.nodes.push({ id: "legacy-gate", title: "legacy", type: "approval", config: { actionNodeId: "db" } });
  legacy.edges.find((e: Json) => e.target === "db").target = "legacy-gate";
  legacy.edges.push({ source: "legacy-gate", target: "db", port: "next" });
  source.draft = legacy;
  repo.put("workflows", source.id, source);
  const version = repo.get("versions", source.id + "@1.0.0");
  version.snapshot.workflow = legacy;
  version.snapshotHash = "sha256:" + hash(version.snapshot);
  repo.put("versions", version.id, version);
  const before = hash({ source, version });
  repo.insert("runs", "legacy-waiting", { id: "legacy-waiting", owner: "execution", state: "WAITING_APPROVAL",
    workflowId: source.id, version: "1.0.0", snapshot: version.snapshot, snapshotHash: version.snapshotHash,
    current: "legacy-gate", steps: { "legacy-gate": "WAITING_APPROVAL" }, revision: 1, createdAt: new Date().toISOString() });
  repo.insert("approvals", "legacy-record", { id: "legacy-record", runId: "legacy-waiting", state: "PENDING" });
  const migrated = await api("/workflows/" + source.id + "/migrate-legacy", {
    targetId: "legacy-migrated-copy", expectedRevision: source.revision, sourceVersion: "1.0.0",
  });
  assert.equal(migrated.status, 200, JSON.stringify(migrated));
  assert.equal(migrated.data.published, false);
  assert.equal(migrated.data.draft.defaultVersion, null);
  assert.equal(migrated.data.draft.draft.nodes.some((n: Json) => n.type === "approval"), false);
  assert.equal(hash({ source: repo.get("workflows", source.id), version: repo.get("versions", version.id) }), before);
  assert.ok((await readFile(migrated.data.backup)).byteLength > 0);
  await assert.rejects(async () => d.engine.start({ workflowId: source.id, version: "1.0.0", mode: "guided", inputs,
    idempotencyKey: crypto.randomUUID() }));
  // Simulate an interrupted old installation whose seed completion marker is absent.
  repo.remove("settings", "seeded");
  await d.close();
  const restarted = await startDaemon({ dataDir, port: 0 });
  try {
    assert.equal(restarted.engine.status("legacy-waiting").state, "CANCELLED");
    assert.equal(restarted.engine.status("legacy-waiting").waitingReason, "LEGACY_WORKFLOW_RETIRED");
    assert.equal(restarted.engine.repo.get("approvals", "legacy-record").state, "PENDING");
    assert.equal(hash(restarted.engine.repo.get("versions", version.id)), hash(version));
    const backups = await import("node:fs/promises").then(fs => fs.readdir(join(dataDir, "backups")));
    assert.ok(backups.some(file => file.startsWith("pre-legacy-retirement-")));
  } finally { await restarted.close(); }
});
