import {
  clone,
  ensure,
  type Workflow,
  type Json,
} from "../../contracts/src/domain.js";

/** Pure conversion. A new draft is created; source drafts and versions stay intact. */
export function withoutLegacyNodes(source: Workflow): Workflow {
  const w = clone(source);
  const removed = new Set(
    w.nodes.filter((n) => n.type === "approval").map((n) => n.id),
  );
  ensure(
    removed.size,
    "MIGRATION_NOT_NEEDED",
    "This workflow has no legacy nodes.",
  );
  // Decision outputs cannot be preserved without inventing execution semantics.
  function references(value: Json): void {
    if (!value || typeof value !== "object") return;
    if (Object.hasOwn(value, "value")) return;
    ensure(
      !value.ref || !removed.has(value.ref.nodeId),
      "MIGRATION_MANUAL_REQUIRED",
      "A node references a removed decision output. Edit a copy explicitly.",
    );
    for (const child of Object.values(value)) references(child);
  }
  for (const node of w.nodes.filter((n) => !removed.has(n.id)))
    for (const key of [
      "argumentsMappings",
      "inputMappings",
      "expression",
      "resultRef",
    ])
      references(node.config[key]);
  function destination(id: string, visited = new Set<string>()): string {
    if (!removed.has(id)) return id;
    ensure(
      !visited.has(id),
      "MIGRATION_MANUAL_REQUIRED",
      "Legacy node chain has a cycle.",
    );
    visited.add(id);
    const exits = w.edges.filter((e) => e.source === id);
    ensure(
      exits.length === 1 && exits[0]!.port === "next",
      "MIGRATION_MANUAL_REQUIRED",
      "Legacy node has ambiguous exits. Edit a copy explicitly.",
    );
    return destination(exits[0]!.target, visited);
  }
  w.edges = w.edges
    .filter((e) => !removed.has(e.source))
    .map((e) => ({ ...e, target: destination(e.target) }));
  w.nodes = w.nodes.filter((n) => !removed.has(n.id));
  return w;
}
