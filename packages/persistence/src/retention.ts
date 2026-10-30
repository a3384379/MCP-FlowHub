import { ensure, hash, type Json } from "../../contracts/src/domain.js";
import type { Repository } from "./repository.js";

const day = 86400000;
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "OUTCOME_UNKNOWN",
]);

export function previewRetention(repo: Repository, at = Date.now()) {
  const records = repo.all("runs");
  const artifacts = repo.all("artifacts");
  const eligible = records.filter((run) => terminal.has(run.state));
  const runs = eligible
    .filter((run) => Date.parse(run.updatedAt) < at - 30 * day)
    .map((run) => run.id as string);
  const deleted = new Set(runs);
  const expiredArtifacts = new Set(
    artifacts
      .filter((artifact) => artifact.expiresAt <= at)
      .map((artifact) => artifact.runId),
  );
  const resultRuns = eligible
    .filter(
      (run) =>
        !deleted.has(run.id) &&
        (expiredArtifacts.has(run.id) ||
          (Date.parse(run.updatedAt) < at - 7 * day &&
            (!run.resultsExpiredAt || !!run.operationalInputs))),
    )
    .map((run) => run.id as string);
  const expired = new Set(resultRuns);
  const checkpoints = eligible
    .filter((run) => !deleted.has(run.id) && !!run.checkpoint)
    .map((run) => run.id as string);
  const artifactIds = artifacts
    .filter(
      (artifact) => deleted.has(artifact.runId) || expired.has(artifact.runId),
    )
    .map((artifact) => artifact.id as string);
  const changed = new Set([...runs, ...resultRuns, ...checkpoints]);
  const scope = { runs, resultRuns, checkpoints, artifacts: artifactIds };
  // Bind confirmation to the selected records as well as IDs. A terminal run
  // changing after preview must not silently reuse a stale cleanup decision.
  const digest = hash({
    scope,
    records: records.filter((run) => changed.has(run.id)),
    artifacts: artifacts.filter((artifact) =>
      artifactIds.includes(artifact.id),
    ),
    approvals: repo
      .all("approvals")
      .filter((approval) => changed.has(approval.runId)),
    events: [...changed].map((runId) =>
      repo.db
        .prepare("SELECT body FROM run_events WHERE run_id=? ORDER BY seq")
        .all(runId),
    ),
  });
  return { ...scope, hash: digest };
}

export function commitRetention(
  repo: Repository,
  previewHash: unknown,
  at = Date.now(),
) {
  // Remove freed payload bytes from current SQLite pages too, so a new backup
  // cannot retain them in unused cells/overflow pages. Existing backups and WAL
  // history have their own lifecycle; this is not a secure-erase guarantee.
  repo.db.pragma("secure_delete = ON");
  return repo.tx(() => {
    const preview = previewRetention(repo, at);
    ensure(
      preview.hash === previewHash,
      "REVISION_CONFLICT",
      "Cleanup scope changed.",
      409,
    );
    const timestamp = new Date(at).toISOString();
    for (const artifactId of preview.artifacts)
      repo.remove("artifacts", artifactId);
    for (const runId of preview.resultRuns) {
      const run = repo.get("runs", runId);
      run.outputs = {};
      delete run.operationalOutputs;
      delete run.operationalInputs;
      run.inputsExpiredAt = timestamp;
      delete run.checkpoint;
      run.resultsExpiredAt = timestamp;
      run.revision++;
      // Preserve updatedAt: maintenance must not extend metadata retention.
      repo.put("runs", runId, run);
      for (const approval of repo
        .all("approvals")
        .filter((item) => item.runId === runId)) {
        delete approval.arguments;
        approval.resultsExpiredAt = timestamp;
        repo.put("approvals", approval.id, approval);
      }
      const events = repo.db
        .prepare("SELECT seq,body FROM run_events WHERE run_id=?")
        .all(runId) as { seq: number; body: string }[];
      for (const event of events) {
        const body = JSON.parse(event.body) as Json;
        if (Object.hasOwn(body, "reason")) {
          delete body.reason;
          repo.db
            .prepare("UPDATE run_events SET body=? WHERE run_id=? AND seq=?")
            .run(JSON.stringify(body), runId, event.seq);
        }
      }
    }
    for (const runId of preview.checkpoints) {
      const run = repo.get("runs", runId);
      if (!run.checkpoint) continue;
      delete run.checkpoint;
      run.revision++;
      repo.put("runs", runId, run);
    }
    for (const runId of preview.runs) {
      for (const table of ["attempts", "approvals"] as const)
        for (const item of repo
          .all(table)
          .filter((item) => item.runId === runId))
          repo.remove(table, item.id);
      repo.db.prepare("DELETE FROM run_events WHERE run_id=?").run(runId);
      // Commands store request hashes and small run summaries, not payloads.
      repo.db
        .prepare(
          "DELETE FROM commands WHERE json_extract(response,'$.runId')=?",
        )
        .run(runId);
      repo.remove("runs", runId);
    }
    repo.audit("admin", "retention:cleanup", String(preview.runs.length));
    return {
      deletedRuns: preview.runs.length,
      deletedArtifacts: preview.artifacts.length,
      expiredResultRuns: preview.resultRuns.length,
      clearedCheckpoints: preview.checkpoints.length,
    };
  });
}
