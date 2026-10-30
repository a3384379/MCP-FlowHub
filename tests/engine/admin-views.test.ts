import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault, AdminAuth } from "../../packages/security/src/index.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { registerAdmin } from "../../packages/admin-api/src/index.js";
import {
  bindingImpact,
  runListView,
} from "../../packages/admin-api/src/admin-views.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

const workflow = {
  workflowId: "history-demo",
  name: "Synthetic history",
  version: "1.0.0",
  environment: "staging",
  bindings: { db: "binding-demo" },
  nodes: [
    {
      id: "read",
      title: "Read",
      type: "mcp_tool",
      config: { bindingKey: "db", toolName: "read" },
    },
  ],
};
function run(index: number, overrides: Json = {}) {
  return {
    id: "history-" + index,
    owner: "execution",
    workflowId: workflow.workflowId,
    version: workflow.version,
    environment: workflow.environment,
    snapshot: { workflow, bindings: [{ id: "binding-demo", revision: 2 }] },
    snapshotHash: "sha256:synthetic",
    inputs: {},
    state: index % 2 ? "SUCCEEDED" : "FAILED",
    current: "read",
    steps: { read: "SUCCEEDED" },
    revision: 1,
    createdAt: new Date(1800000000000 + index).toISOString(),
    retryOfRunId: null,
    ...overrides,
  };
}

test("run pagination reaches all older history, binds filters, and stays stable when new runs arrive", (t) => {
  const db = new Database(":memory:"),
    repo = new Repository(db);
  t.after(() => db.close());
  repo.tx(() => {
    for (let i = 1; i <= 623; i++) repo.insert("runs", "history-" + i, run(i));
  });
  const view = runListView(repo);
  const first = view({ limit: "91" });
  assert.equal(first.meta.total, 623);
  assert.equal(first.data[0]!.id, "history-623");
  assert.equal(first.meta.hasMore, true);
  repo.insert("runs", "history-624", run(624));
  const ids = first.data.map((item) => item.id);
  let cursor = first.meta.nextCursor;
  while (cursor) {
    const page = view({ limit: "91", cursor });
    ids.push(...page.data.map((item) => item.id));
    assert.equal(page.meta.total, 623);
    cursor = page.meta.nextCursor;
  }
  assert.equal(ids.length, 623);
  assert.equal(new Set(ids).size, 623);
  assert.equal(ids.at(-1), "history-1");
  const filtered = view({
    state: "FAILED",
    workflowId: "history-demo",
    environment: "staging",
    limit: "70",
  });
  assert.equal(filtered.meta.total, 312);
  assert.ok(filtered.data.every((item) => item.state === "FAILED"));
  assert.throws(
    () => view({ cursor: filtered.meta.nextCursor }),
    /selected filters/,
  );
  assert.throws(() => view({ cursor: "not-a-cursor" }), /Invalid run cursor/);
  const forged = first.meta.nextCursor!.split(".");
  forged[0] = "A" + forged[0]!.slice(1);
  assert.throws(
    () => view({ cursor: forged.join(".") }),
    /invalid or has expired/,
  );
  const restartedView = runListView(repo);
  assert.throws(
    () => restartedView({ cursor: first.meta.nextCursor }),
    /invalid or has expired/,
  );
  for (const query of [
    { limit: "0" },
    { limit: "201" },
    { limit: "2.5" },
    { state: "NOT_A_STATE" },
    { workflowId: ["history-demo"] },
  ])
    assert.throws(() => view(query));
});

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-admin-views-"));
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo);
  const auth = new AdminAuth(repo);
  auth.setup("Synthetic-admin-views-password-38");
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  const app = Fastify();
  await registerAdmin(app, engine, dataDir);
  const login = await app.inject({
    method: "POST",
    url: "/api/v1/auth/session",
    payload: { password: "Synthetic-admin-views-password-38" },
  });
  assert.equal(login.statusCode, 200);
  const cookie = String(login.headers["set-cookie"]).split(";")[0]!;
  t.after(async () => {
    await engine.close();
    await app.close();
    db.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const get = async (path: string, authenticated = true) => {
    const response = await app.inject({
      method: "GET",
      url: "/api/v1" + path,
      headers: authenticated ? { cookie } : {},
    });
    return { status: response.statusCode, ...response.json() };
  };
  return { repo, get };
}

test("admin run responses preserve data arrays and paginate events beyond 200 with strict cursor bounds", async (t) => {
  const { repo, get } = await fixture(t);
  const record = run(1);
  repo.insert("runs", record.id, record);
  repo.tx(() => {
    for (let i = 1; i <= 451; i++)
      repo.event(record.id, "SYNTHETIC_EVENT", { index: i });
  });
  const denied = await get("/runs", false);
  assert.equal(denied.status, 401);
  const list = await get("/runs?state=SUCCEEDED&limit=1");
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.data));
  assert.equal(list.meta.total, 1);
  assert.equal(list.meta.nextCursor, null);
  const events: Json[] = [];
  let after = 0,
    more = true;
  while (more) {
    const page = await get("/runs/" + record.id + "?after=" + after);
    assert.equal(page.status, 200);
    events.push(...page.data.events);
    assert.equal(page.data.eventCursor.after, after);
    after = page.data.eventCursor.nextAfter;
    more = page.data.eventCursor.hasMore;
  }
  assert.equal(events.length, 451);
  assert.equal(new Set(events.map((event) => event.seq)).size, 451);
  assert.equal(after, 451);
  const tail = await get("/runs/" + record.id + "?after=450&limit=1");
  assert.equal(tail.data.events[0].seq, 451);
  for (const suffix of [
    "after=-1",
    "after=1.5",
    "after=NaN",
    "after=9007199254740992",
    "after=1&after=2",
    "limit=0",
    "limit=501",
  ])
    assert.equal(
      (await get("/runs/" + record.id + "?" + suffix)).status,
      422,
      suffix,
    );
});

test("binding impact resolves drafts, immutable publications and active snapshots without leaking arguments or mutating state", async (t) => {
  const { repo, get } = await fixture(t);
  repo.insert("bindings", "binding-demo", {
    id: "binding-demo",
    revision: 3,
    validationStatus: "BINDING_VERIFIED",
    lockedArguments: { "/password": "SYNTHETIC-SECRET-DO-NOT-EXPOSE" },
  });
  repo.insert("workflows", workflow.workflowId, {
    id: workflow.workflowId,
    name: workflow.name,
    environment: workflow.environment,
    draft: { ...workflow, version: "2.0.0" },
    revision: 5,
    enabled: true,
    defaultVersion: "1.0.0",
  });
  repo.insert("versions", workflow.workflowId + "@1.0.0", {
    id: workflow.workflowId + "@1.0.0",
    workflowId: workflow.workflowId,
    version: "1.0.0",
    snapshot: {
      workflow,
      bindings: [
        { id: "binding-demo", revision: 2, secretRef: "DO-NOT-EXPOSE-REF" },
      ],
    },
  });
  repo.insert(
    "runs",
    "history-1",
    run(1, { state: "WAITING_APPROVAL", steps: { read: "PENDING" } }),
  );
  repo.insert(
    "runs",
    "history-2",
    run(2, { state: "RUNNING", dispatch: { attemptId: "external-in-flight" } }),
  );
  repo.insert("runs", "history-3", run(3));
  repo.insert(
    "runs",
    "history-4",
    run(4, {
      state: "BLOCKED",
      snapshot: { workflow: { ...workflow, bindings: {} }, bindings: [] },
    }),
  );
  const before = hash({
    bindings: repo.all("bindings"),
    versions: repo.all("versions"),
    runs: repo.all("runs"),
  });
  const impact = await get("/bindings/binding-demo/impact");
  assert.equal(impact.status, 200);
  assert.deepEqual(impact.data.summary, {
    draftWorkflows: 1,
    publishedVersions: 1,
    activeRuns: 2,
  });
  assert.equal(impact.data.revision, 3);
  assert.equal(impact.data.draftWorkflows[0].version, "2.0.0");
  assert.equal(impact.data.publishedVersions[0].version, "1.0.0");
  assert.equal(impact.data.publishedVersions[0].bindingRevision, 2);
  assert.equal(impact.data.publishedVersions[0].requiresRepublish, true);
  assert.deepEqual(impact.data.activeRuns[0].remainingNodeIds, ["read"]);
  assert.equal(impact.data.activeRuns[1].inFlight, true);
  assert.deepEqual(impact.data.activeRuns[1].remainingNodeIds, []);
  assert.ok(
    impact.data.activeRuns.every(
      (r: Json) => r.blocksOnNextAdmission && r.snapshotBindingRevision === 2,
    ),
  );
  assert.ok(!JSON.stringify(impact).includes("DO-NOT-EXPOSE"));
  assert.equal(
    before,
    hash({
      bindings: repo.all("bindings"),
      versions: repo.all("versions"),
      runs: repo.all("runs"),
    }),
  );
  assert.deepEqual(bindingImpact(repo, "binding-demo"), impact.data);
  assert.equal((await get("/bindings/missing/impact")).status, 404);
  assert.equal((await get("/bindings/binding-demo/impact", false)).status, 401);
});
