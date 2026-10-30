import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { hash, type Json } from "../../packages/contracts/src/domain.js";

test("retention removes expired result copies before new backups and preserves active runs and recent results", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "flowhub-retention-copies-"));
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
      password: "Synthetic-retention-password-241",
    }),
  });
  assert.equal(setup.status, 200);
  const cookie = setup.headers.get("set-cookie")!.split(";")[0]!,
    csrf = ((await setup.json()) as Json).data.csrf;
  const api = async (path: string, data: Json) => {
    const response = await fetch(base + path, {
      method: "POST",
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(data),
    });
    return { status: response.status, ...((await response.json()) as Json) };
  };
  const flow = daemon.engine.repo.get("workflows", "incident-staging").draft;
  const started = await api("/runs", {
    workflowId: flow.workflowId,
    version: flow.version,
    mode: flow.mode,
    inputs: flow.inputSchema.examples[0],
    idempotencyKey: randomUUID(),
  });
  assert.equal(started.status, 200);
  let status: Json;
  for (let i = 0; i < 200; i++) {
    status = daemon.engine.status(started.data.runId);
    if (status.state === "WAITING_AGENT") break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status!.state, "WAITING_AGENT");
  daemon.engine.cancel({
    runId: status!.runId,
    expectedRevision: status!.revision,
    reason: "synthetic retention fixture",
    idempotencyKey: randomUUID(),
  });
  const repo = daemon.engine.repo;
  const expired = repo.get("runs", started.data.runId);
  const marker = "synthetic-business-result-" + randomUUID();
  const ago = (days: number) =>
    new Date(Date.now() - days * 86400000).toISOString();
  expired.updatedAt = ago(8);
  expired.outputs.log = { logs: [{ message: marker }] };
  expired.outputs.analysis = { summary: marker };
  expired.outputs.report = { reportMarkdown: marker };
  expired.checkpoint = {
    inputs: { raw: marker },
    delivery: { ciphertext: "terminal leftover" },
  };
  repo.put("runs", expired.id, expired);
  for (const artifact of repo
    .all("artifacts")
    .filter((artifact) => artifact.runId === expired.id)) {
    repo.put("artifacts", artifact.id, {
      ...artifact,
      content: marker,
      createdAt: ago(8),
      expiresAt: Date.now() - 1,
    });
  }
  const approval = {
    id: "approval-" + randomUUID(),
    runId: expired.id,
    state: "APPROVED",
    arguments: { copied: marker },
    actionHash: hash(marker),
    snapshotHash: expired.snapshotHash,
  };
  repo.insert("approvals", approval.id, approval);
  repo.event(expired.id, "CANCEL_REQUESTED", { reason: marker });

  const active = structuredClone(expired);
  active.id = "run-active-" + randomUUID();
  active.state = "WAITING_AGENT";
  active.updatedAt = ago(40);
  active.outputs = {
    log: { logs: [{ message: "active result must remain" }] },
  };
  active.checkpoint = { inputs: { raw: "active checkpoint" } };
  repo.insert("runs", active.id, active);
  const activeArtifact = {
    id: "art-active-" + randomUUID(),
    runId: active.id,
    content: "active artifact",
    expiresAt: Date.now() - 1,
  };
  repo.insert("artifacts", activeArtifact.id, activeArtifact);
  const activeHash = hash(active);

  const recent = structuredClone(expired);
  recent.id = "run-recent-" + randomUUID();
  recent.updatedAt = ago(1);
  recent.outputs = {
    log: { logs: [{ message: "recent result must remain" }] },
  };
  recent.checkpoint = { inputs: { raw: "terminal recent checkpoint" } };
  repo.insert("runs", recent.id, recent);
  const recentArtifact = {
    id: "art-recent-" + randomUUID(),
    runId: recent.id,
    content: "recent artifact",
    expiresAt: Date.now() + 86400000,
  };
  repo.insert("artifacts", recentArtifact.id, recentArtifact);

  const metadataExpired = structuredClone(expired);
  metadataExpired.id = "run-old-" + randomUUID();
  metadataExpired.updatedAt = ago(31);
  repo.insert("runs", metadataExpired.id, metadataExpired);
  repo.insert("approvals", "old-approval", {
    id: "old-approval",
    runId: metadataExpired.id,
    arguments: { copied: marker },
  });
  repo.insert("attempts", "old-attempt", {
    id: "old-attempt",
    runId: metadataExpired.id,
    inputHash: hash(marker),
  });
  repo.event(metadataExpired.id, "CANCEL_REQUESTED", { reason: marker });
  repo.command("execution", "start", "old-retention-command", {}, () => ({
    runId: metadataExpired.id,
  }));

  const preview = await api("/retention/preview", {});
  assert.equal(preview.status, 200);
  assert.equal(preview.data.runs.includes(active.id), false);
  const commit = await api("/retention/commit", {
    previewHash: preview.data.hash,
  });
  assert.equal(commit.status, 200);
  const remaining = repo.get("runs", expired.id);
  assert.equal(
    JSON.stringify(remaining.outputs).includes(marker),
    false,
    "expired raw results survived outside artifacts",
  );
  assert.deepEqual(remaining.outputs, {});
  assert.equal(remaining.checkpoint, undefined);
  assert.equal(typeof remaining.resultsExpiredAt, "string");
  assert.deepEqual(remaining.inputs, expired.inputs);
  assert.equal(remaining.updatedAt, expired.updatedAt);
  const retainedApproval = repo.get("approvals", approval.id);
  assert.equal(retainedApproval.arguments, undefined);
  assert.equal(retainedApproval.actionHash, approval.actionHash);
  assert.equal(retainedApproval.state, "APPROVED");
  assert.equal(
    JSON.stringify(repo.events(expired.id, 0, 10000)).includes(marker),
    false,
  );
  assert.equal(
    repo.all("artifacts").some((artifact) => artifact.runId === expired.id),
    false,
  );
  assert.equal(hash(repo.get("runs", active.id)), activeHash);
  assert.deepEqual(repo.get("artifacts", activeArtifact.id), activeArtifact);
  assert.deepEqual(repo.get("runs", recent.id).outputs, recent.outputs);
  assert.equal(repo.get("runs", recent.id).checkpoint, undefined);
  assert.deepEqual(repo.get("artifacts", recentArtifact.id), recentArtifact);
  assert.equal(repo.get("runs", metadataExpired.id), undefined);
  assert.equal(repo.get("approvals", "old-approval"), undefined);
  assert.equal(repo.get("attempts", "old-attempt"), undefined);
  assert.deepEqual(repo.events(metadataExpired.id), []);
  assert.equal(
    (
      repo.db
        .prepare(
          "SELECT COUNT(*) AS count FROM commands WHERE key='old-retention-command'",
        )
        .get() as { count: number }
    ).count,
    0,
  );

  const backup = await api("/backups", {});
  assert.equal(backup.status, 200);
  const backupBytes = await readFile(
    join(directory, "backups", backup.data.filename),
  );
  assert.equal(
    backupBytes.includes(Buffer.from(marker)),
    false,
    "new backup retained raw result bytes in unused SQLite cells",
  );
  const backupDb = new Database(
    join(directory, "backups", backup.data.filename),
    { readonly: true },
  );
  try {
    for (const table of [
      "runs",
      "artifacts",
      "approvals",
      "run_events",
      "commands",
    ] as const) {
      const column = table === "commands" ? "response" : "body";
      const rows = backupDb
        .prepare("SELECT " + column + " AS content FROM " + table)
        .all() as { content: string }[];
      assert.equal(
        rows.some((row) => row.content.includes(marker)),
        false,
        "new backup retained expired raw result copies",
      );
    }
  } finally {
    backupDb.close();
  }
  assert.equal(
    (await api("/retention/commit", { previewHash: preview.data.hash })).status,
    409,
  );
});
