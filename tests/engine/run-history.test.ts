import assert from "node:assert/strict";
import { test } from "node:test";
import Database from "better-sqlite3";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { MIGRATIONS, migrate } from "../../packages/persistence/src/migrations.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";

test("full and checkpoint status use indexed history for one run and return artifact metadata", t => {
  const queries: string[] = [];
  const db = new Database(":memory:", { verbose: sql => {
    if (typeof sql === "string" && /^SELECT .* FROM (attempts|artifacts)\b/i.test(sql)) queries.push(sql);
  } });
  t.after(() => db.close());
  const repo = new Repository(db);
  const vault = new Vault(repo);
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  const nodes = ["first", "second", "last"].map(id => ({ id, title: id, type: "agent_task", config: {} }));
  repo.insert("runs", "selected", {
    id: "selected", owner: "reader", state: "FAILED", inputs: {}, steps: {}, outputs: {},
    snapshot: { workflow: { nodes } }, hostReported: { second: { errorCode: "FROM_RECEIPT" } },
  });
  const expiresAt = Date.now() + 86400000;
  const metadata = { id: "local", runId: "selected", nodeId: "first", expiresAt, mimeType: "text/plain",
    verification: { formatValidated: true, nested: { content: "保留元数据" } }, legacyAttribute: null };
  repo.insert("artifacts", "local", { ...metadata, content: "归档原文" });
  const expired = { id: "expired", runId: "selected", expiresAt: 0 };
  repo.insert("artifacts", "expired", { ...expired, content: "过期" });
  const start = new Date(0).toISOString(), end = new Date(100).toISOString();
  repo.insert("attempts", "retry-z", { runId: "selected", nodeId: "first", createdAt: start, finishedAt: end, errorCode: "OLD" });
  repo.insert("attempts", "unfinished", { runId: "selected", nodeId: "second", createdAt: start });
  repo.insert("attempts", "retry-a", { runId: "selected", nodeId: "first", createdAt: end, finishedAt: start, errorCode: "LAST" });
  for (let i = 0; i < 40; i++) {
    repo.insert("artifacts", "other-" + i, { id: "other-" + i, runId: "other", expiresAt, content: "x".repeat(4096) });
    repo.insert("attempts", "other-" + i, { runId: "other", nodeId: "first", createdAt: start, finishedAt: end, errorCode: "FOREIGN" });
  }
  queries.length = 0;
  assert.throws(() => engine.status("selected", "stranger"), { code: "WORKFLOW_NOT_AVAILABLE" });
  assert.equal(queries.length, 0);
  const status = engine.status("selected", "reader");
  assert.deepEqual(status.artifacts, [metadata, expired]);
  assert.equal(status.reportArchived, true);
  assert.deepEqual(status.nodeDetails.map((node: { durationMs: number; errorCode?: string }) => [node.durationMs, node.errorCode]), [
    [100, "LAST"], [0, "FROM_RECEIPT"], [0, undefined],
  ]);
  function assertIndexedRead(table: "artifacts" | "attempts") {
    const statements = queries.filter(sql => sql.includes(" FROM " + table + " "));
    assert.equal(statements.length, 1, "one query per run for " + table);
    const plan = db.prepare("EXPLAIN QUERY PLAN " + statements[0]).all() as { detail: string }[];
    assert.ok(plan.some(row => row.detail.includes("SEARCH " + table + " USING INDEX " + table + "_by_run")));
    return statements[0]!;
  }
  assert.match(assertIndexedRead("artifacts"), /json_remove\(body,'\$\.content'\)/);
  assertIndexedRead("attempts");
  queries.length = 0;
  assert.deepEqual(engine.handle("workflow_status", { runId: "selected", view: "checkpoint" }, "reader").artifacts, [metadata, expired]);
  assertIndexedRead("artifacts");
  assert.equal(queries.length, 1);
  assert.deepEqual(repo.artifactsForRun("selected", "summary", expiresAt - 1), [metadata]);
  assert.equal(engine.readArtifact({ runId: "selected", artifactId: "local" }, "reader").content, "归档原文");
  assert.throws(() => engine.readArtifact({ runId: "selected", artifactId: "expired" }, "reader"), { code: "ARTIFACT_NOT_AVAILABLE" });
});

test("v4 indexes preserve v3 history bytes and include legacy nonterminal runs in admission and recovery", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 3));
  const states = ["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED", "OUTCOME_UNKNOWN", "WAITING_APPROVAL", "BLOCKED", null];
  for (const [i, state] of states.entries()) {
    db.prepare("INSERT INTO runs VALUES(?,1,?)").run("run-" + i, JSON.stringify({ id: "run-" + i, state }));
  }
  const version = '{"id":"v1", "snapshot":{"preserve":"中文"}}';
  db.prepare("INSERT INTO versions VALUES('v1',1,?)").run(version);
  const artifact = '{ "id":"old", "runId":"run-0", "content":"原文" }';
  db.prepare("INSERT INTO artifacts VALUES('old',1,?)").run(artifact);
  const history = db.prepare("SELECT * FROM schema_migrations ORDER BY version").all();
  const repo = new Repository(db);
  assert.deepEqual(db.prepare("SELECT * FROM schema_migrations WHERE version <= 3 ORDER BY version").all(), history);
  assert.equal(db.prepare("SELECT body FROM versions").pluck().get(), version);
  assert.equal(db.prepare("SELECT body FROM artifacts").pluck().get(), artifact);
  assert.deepEqual(repo.artifactsForRun("run-0", "summary"), [{ id: "old", runId: "run-0" }]);
  assert.deepEqual(repo.activeRuns().map(r => r.state), states.slice(5));
  assert.equal(repo.activeRunCount(), 3);
  repo.put("runs", "run-5", { id: "run-5", state: "CANCELLED" });
  assert.equal(repo.activeRunCount(), 2);
  assert.deepEqual(repo.activeRuns().map(r => r.id), ["run-6", "run-7"]);
});

test("history accepts valid business JSON beyond SQLite's JSON nesting limit before and after upgrade", t => {
  const db = new Database(":memory:");
  t.after(() => db.close());
  migrate(db, MIGRATIONS.slice(0, 3));
  const deep = "[".repeat(1100) + "0" + "]".repeat(1100);
  const old = '{"id":"old","state":"REJECTED","outputs":' + deep + '}';
  const artifact = '{"id":"evidence","runId":"old","content":"业务原文","verification":' + deep + '}';
  db.prepare("INSERT INTO runs VALUES('old',1,?)").run(old);
  db.prepare("INSERT INTO artifacts VALUES('evidence',1,?)").run(artifact);
  db.prepare("INSERT INTO attempts VALUES('first',1,?)").run('{"runId":"old","id":"first","payload":' + deep + '}');
  const repo = new Repository(db);
  repo.insert("runs", "new", { id: "new", state: "RUNNING", inputs: JSON.parse(deep) });
  repo.insert("artifacts", "foreign", { id: "foreign", runId: "new", content: "other", metadata: JSON.parse(deep) });
  repo.insert("attempts", "second", { id: "second", runId: "old" });
  assert.equal(repo.activeRunCount(), 1);
  assert.deepEqual(repo.activeRuns().map(run => run.id), ["new"]);
  assert.deepEqual(repo.attemptsForRun("old").map(attempt => attempt.id), ["first", "second"]);
  assert.deepEqual(repo.attemptsForRun("new"), []);
  const summaries = repo.artifactsForRun("old", "summary");
  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].id, "evidence");
  assert.equal(Object.hasOwn(summaries[0], "content"), false);
  assert.equal(JSON.stringify(summaries[0].verification), deep);
  assert.equal(JSON.stringify(repo.artifactsForRun("old", "content")[0]), artifact);
  assert.equal(db.prepare("SELECT body FROM runs WHERE id='old'").pluck().get(), old);
});
