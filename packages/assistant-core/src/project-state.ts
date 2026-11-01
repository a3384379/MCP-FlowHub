import type { Application } from "../../application/src/index.js";
import { now, type Json } from "../../contracts/src/domain.js";

/** A read-only projection. Never read transport configuration, credentials or run data. */
export function projectState(app: Application, owner: string): Json {
  try {
    app.authoring.authorize(owner);
  } catch {
    return { status: "unavailable", reason: "AUTH_REQUIRED" };
  }
  const db = app.engine.repo.db;
  const rows = (sql: string) => db.prepare(sql).all() as Json[];
  const connections = rows(`SELECT id, json_extract(body,'$.name') AS name,
    json_extract(body,'$.disabled') AS disabled, revision,
    json_extract(body,'$.verifiedRevision') AS verifiedRevision,
    coalesce(json_array_length(body,'$.tools'),0) AS toolCount,
    (SELECT json_group_array(json_extract(value,'$.name')) FROM
      (SELECT value FROM json_each(connections.body,'$.tools') LIMIT 60)) AS cachedTools
    FROM connections ORDER BY id`);
  const contexts = rows(`SELECT id, revision FROM host_contexts ORDER BY id`);
  const scans = rows(`SELECT id, json_extract(body,'$.contextId') AS contextId,
    json_extract(body,'$.contextRevision') AS contextRevision,
    json_extract(body,'$.generation') AS generation, json_extract(body,'$.depth') AS depth,
    json_extract(body,'$.status') AS status, json_extract(body,'$.coverage') AS coverage,
    json_extract(body,'$.completedAt') AS completedAt, json_extract(body,'$.createdAt') AS createdAt,
    json_extract(body,'$.issues') AS issues FROM discovery_jobs ORDER BY json_extract(body,'$.generation') DESC`);
  const latest = contexts.map((c) => {
    const scan = scans.find(
      (s) => s.contextId === c.id && s.contextRevision === c.revision,
    );
    return {
      contextId: c.id,
      status: scan?.status ?? "NOT_SCANNED",
      depth: scan?.depth ?? null,
      scanId: scan?.id ?? null,
      coverage: scan?.coverage ?? "unknown",
      at: scan?.completedAt ?? scan?.createdAt ?? null,
      issues: scan
        ? JSON.parse(scan.issues ?? "[]").map((i: Json) => ({
            code: i.code,
            sourceId: i.sourceId ?? null,
          }))
        : [],
    };
  });
  const sources = rows(`SELECT id, json_extract(body,'$.name') AS name,
    json_extract(body,'$.contextId') AS contextId, json_extract(body,'$.contextRevision') AS contextRevision,
    json_extract(body,'$.kind') AS kind, json_extract(body,'$.executor') AS executor,
    json_extract(body,'$.enabled') AS enabled, json_extract(body,'$.availability') AS availability,
    json_extract(body,'$.discovery') AS discovery, json_extract(body,'$.self') AS self,
    json_extract(body,'$.stale') AS stale FROM capability_sources ORDER BY id`).map(
    (s) => ({
      ...s,
      stale:
        !!s.stale ||
        !contexts.some(
          (c) => c.id === s.contextId && c.revision === s.contextRevision,
        ),
    }),
  );
  const capabilities = rows(`SELECT id, json_extract(body,'$.name') AS name,
    json_extract(body,'$.contextId') AS contextId, json_extract(body,'$.contextRevision') AS contextRevision,
    json_extract(body,'$.kind') AS kind, json_extract(body,'$.executor') AS executor,
    json_extract(body,'$.enabled') AS enabled, json_extract(body,'$.availability') AS availability,
    json_extract(body,'$.stale') AS stale FROM capabilities ORDER BY id`).map(
    (c) => ({
      ...c,
      stale:
        !!c.stale ||
        !contexts.some(
          (h) => h.id === c.contextId && h.revision === c.contextRevision,
        ),
    }),
  );
  const current = capabilities.filter((c) => !c.stale);
  const states = latest.map((s) => s.status);
  const status =
    !latest.length || states.every((s) => s === "NOT_SCANNED")
      ? "not_scanned"
      : states.some(
            (s) =>
              ![
                "NOT_SCANNED",
                "SUCCEEDED",
                "PARTIAL",
                "FAILED",
                "CANCELLED",
              ].includes(s),
          )
        ? "scanning"
        : states.every((s) => s === "FAILED" || s === "CANCELLED")
          ? "failed"
          : states.some((s) => s !== "SUCCEEDED")
            ? "partial"
            : sources.some(
                  (s) =>
                    !s.stale &&
                    !s.self &&
                    s.kind !== "skill" &&
                    s.discovery !== "schema_discovered",
                )
              ? "metadata_only"
              : "ready";
  const toolCountKnown =
    status === "ready" && latest.every((s) => s.depth === "catalog");
  const page = (items: Json[], limit = 60) => ({
    count: items.length,
    items: items.slice(0, limit),
    truncated: items.length > limit,
  });
  return {
    status: "checked",
    checkedAt: now(),
    registeredConnections: page(
      connections.map((c) => ({
        id: c.id,
        name: c.name,
        enabled: !c.disabled,
        cachedToolCount: c.toolCount,
        cachedTools: JSON.parse(c.cachedTools ?? "[]").filter((name:unknown)=>typeof name==="string"),
        toolsTruncated: c.toolCount > 60,
        catalogVerified: c.revision === c.verifiedRevision,
      })),
    ),
    discovery: {
      status,
      toolCountKnown,
      scans: latest.slice(0, 30),
      contextsTruncated: latest.length > 30,
      sources: page(sources),
      cachedCapabilities: page(capabilities),
      currentCounts: {
        mcpTools: current.filter((c) => c.kind === "mcp_tool").length,
        skills: current.filter((c) => c.kind === "skill").length,
        hubDirect: current.filter((c) => c.executor === "hub_direct").length,
        hostOnly: current.filter((c) => c.executor === "codex_host").length,
      },
    },
    interpretation:
      "Stored/cached counts are not a live host inventory. Unknown, not scanned, failed and empty are distinct. Host-only capabilities require Codex; ready metadata is not proof of a business tool call. Read-only discovery does not modify Codex source configuration.",
    nextPage: "/discovery",
  };
}
