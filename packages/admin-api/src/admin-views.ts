import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import {
  ensure,
  hash,
  type Json,
  type Workflow,
} from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
import { businessSummary } from "../../workflow-core/src/business-verification.js";

const runStates = new Set([
  "QUEUED",
  "RUNNING",
  "WAITING_AGENT",
  "BLOCKED",
  "CANCEL_REQUESTED",
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
]);
const terminalStates = new Set([
  "SUCCEEDED",
  "FAILED",
  "REJECTED",
  "CANCELLED",
  "OUTCOME_UNKNOWN",
]);

function integer(
  value: unknown,
  fallback: number,
  maximum: number,
  minimum = 0,
) {
  if (value === undefined) return fallback;
  ensure(
    typeof value === "string" &&
      /^(0|[1-9]\d*)$/.test(value) &&
      Number.isSafeInteger(Number(value)) &&
      Number(value) >= minimum &&
      Number(value) <= maximum,
    "INPUT_INVALID",
    "Invalid pagination cursor or limit.",
  );
  return Number(value);
}

export function eventPageQuery(query: Json, lastEventId?: unknown) {
  return {
    after: integer(query.after ?? lastEventId, 0, Number.MAX_SAFE_INTEGER),
    limit: integer(query.limit, 200, 500, 1),
  };
}

export function eventCursor(
  repo: Repository,
  runId: string,
  after: number,
  limit: number,
  events: Json[],
) {
  const nextAfter = events.at(-1)?.seq ?? after;
  return {
    after,
    nextAfter,
    limit,
    hasMore: repo.events(runId, nextAfter, 1).length > 0,
  };
}

// Cursors are scoped to this daemon lifetime. A restart invalidates them with a
// validation error; clients can restart at page one. The signed upper rowid
// keeps concurrent inserts from shifting an in-progress traversal.
export function runListView(repo: Repository, cursorKey = randomBytes(32)) {
  const sign = (payload: string) =>
    createHmac("sha256", cursorKey).update(payload).digest();
  return (query: Json = {}) => {
    const limit = integer(query.limit, 50, 200, 1);
    const filters: Record<string, string | null> = {};
    for (const key of ["state", "workflowId", "environment"]) {
      const value = query[key];
      ensure(
        value === undefined ||
          (typeof value === "string" &&
            value.length > 0 &&
            value.length <= 256),
        "INPUT_INVALID",
        "Invalid run filter.",
      );
      filters[key] = value ?? null;
    }
    ensure(
      filters.state === null || runStates.has(filters.state!),
      "INPUT_INVALID",
      "Unknown run state filter.",
    );
    const filterHash = hash(filters);
    let upper = (
      repo.db
        .prepare("SELECT COALESCE(MAX(rowid),0) AS upper FROM runs")
        .get() as { upper: number }
    ).upper;
    let before: number | null = null;
    if (query.cursor !== undefined) {
      ensure(
        typeof query.cursor === "string" &&
          query.cursor.length <= 1024 &&
          /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(query.cursor),
        "INPUT_INVALID",
        "Invalid run cursor.",
      );
      const [payload, signature] = query.cursor.split(".") as [string, string];
      const supplied = Buffer.from(signature, "base64url"),
        expected = sign(payload);
      ensure(
        supplied.length === expected.length &&
          timingSafeEqual(supplied, expected),
        "INPUT_INVALID",
        "Run cursor is invalid or has expired; reload the first page.",
      );
      let cursor: Json;
      try {
        cursor = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        ensure(false, "INPUT_INVALID", "Invalid run cursor.");
      }
      ensure(
        cursor &&
          cursor.v === 1 &&
          cursor.filters === filterHash &&
          Number.isSafeInteger(cursor.upper) &&
          cursor.upper >= 0 &&
          Number.isSafeInteger(cursor.before) &&
          cursor.before > 0 &&
          cursor.before <= cursor.upper,
        "INPUT_INVALID",
        "Run cursor does not match the selected filters.",
      );
      upper = cursor.upper;
      before = cursor.before;
    }
    const where = ["rowid <= ?"],
      values: (string | number)[] = [upper];
    for (const [key, value] of Object.entries(filters))
      if (value !== null) {
        // key comes only from the fixed filter list above.
        where.push("json_extract(body, '$." + key + "') = ?");
        values.push(value);
      }
    const total = (
      repo.db
        .prepare(
          "SELECT COUNT(*) AS total FROM runs WHERE " + where.join(" AND "),
        )
        .get(...values) as { total: number }
    ).total;
    if (before !== null) {
      where.push("rowid < ?");
      values.push(before);
    }
    const rows = repo.db
      .prepare(
        "SELECT rowid AS position, body FROM runs WHERE " +
          where.join(" AND ") +
          " ORDER BY rowid DESC LIMIT ?",
      )
      .all(...values, limit + 1) as { position: number; body: string }[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    let nextCursor: string | null = null;
    if (hasMore) {
      const payload = Buffer.from(
        JSON.stringify({
          v: 1,
          filters: filterHash,
          upper,
          before: page.at(-1)!.position,
        }),
      ).toString("base64url");
      nextCursor = payload + "." + sign(payload).toString("base64url");
    }
    return {
      data: page.map(({ body }) => {
        const r = JSON.parse(body);
        return {
          id: r.id,
          workflowId: r.workflowId,
          version: r.version,
          environment: r.environment,
          state: r.state,
          revision: r.revision,
          currentNode: r.current,
          createdAt: r.createdAt,
          snapshotHash: r.snapshotHash,
          retryOfRunId: r.retryOfRunId,
          businessVerification: businessSummary(r),
          reportArchived: r.reportArchived,
          syntheticExecution: r.snapshot?.simulationOnly === true ||
            r.snapshot?.bindings?.some((binding: Json) => binding.simulationOnly === true) === true,
        };
      }),
      meta: { nextCursor, hasMore, limit, total },
    };
  };
}

function bindingReferences(workflow: Workflow, bindingId: string) {
  const bindingKeys = Object.entries(workflow.bindings)
    .filter(([, id]) => id === bindingId)
    .map(([key]) => key);
  const nodeIds = workflow.nodes
    .filter(
      (node) =>
        node.type === "mcp_tool" &&
        bindingKeys.includes(node.config.bindingKey),
    )
    .map((node) => node.id);
  return { bindingKeys, nodeIds };
}

/** Read-only dependency preview. It never changes execution admission or CAS. */
export function bindingImpact(repo: Repository, bindingId: string) {
  const binding = repo.get("bindings", bindingId);
  ensure(binding, "NOT_FOUND", "Binding missing.", 404);
  const workflows = repo.all("workflows");
  const draftWorkflows = workflows.flatMap((record) => {
    if (record.deletedAt) return [];
    const refs = bindingReferences(record.draft, bindingId);
    return refs.bindingKeys.length
      ? [
          {
            workflowId: record.id,
            name: record.name,
            version: record.draft.version,
            environment: record.environment,
            revision: record.revision,
            enabled: record.enabled,
            ...refs,
          },
        ]
      : [];
  });
  const publishedVersions = repo.all("versions").flatMap((version) => {
    const refs = bindingReferences(version.snapshot.workflow, bindingId);
    if (!refs.bindingKeys.length) return [];
    const record = workflows.find(
      (workflow) => workflow.id === version.workflowId,
    );
    return [
      {
        workflowId: version.workflowId,
        name: version.snapshot.workflow.name,
        version: version.version,
        environment: version.snapshot.workflow.environment,
        bindingRevision: version.snapshot.bindings.find(
          (b: Json) => b.id === bindingId,
        )?.revision,
        isDefault: record?.defaultVersion === version.version,
        workflowEnabled: record?.enabled ?? false,
        ...refs,
        requiresRepublish: true,
      },
    ];
  });
  const activeRuns = repo.all("runs").flatMap((run) => {
    if (terminalStates.has(run.state)) return [];
    const frozenBinding = run.snapshot.bindings.find(
      (b: Json) => b.id === bindingId,
    );
    if (!frozenBinding) return [];
    const refs = bindingReferences(run.snapshot.workflow, bindingId);
    return [
      {
        runId: run.id,
        workflowId: run.workflowId,
        version: run.version,
        environment: run.environment,
        state: run.state,
        currentNode: run.current,
        snapshotBindingRevision: frozenBinding.revision,
        remainingNodeIds: refs.nodeIds.filter(
          (id) => !["SUCCEEDED", "SKIPPED"].includes(run.steps[id]),
        ),
        inFlight: !!run.dispatch,
        blocksOnNextAdmission: true,
      },
    ];
  });
  return {
    bindingId,
    revision: binding.revision,
    validationStatus: binding.validationStatus,
    draftWorkflows,
    publishedVersions,
    activeRuns,
    summary: {
      draftWorkflows: draftWorkflows.length,
      publishedVersions: publishedVersions.length,
      activeRuns: activeRuns.length,
    },
  };
}
