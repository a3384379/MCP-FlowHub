import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { withoutLegacyNodes } from "../../packages/workflow-core/src/legacy-migration.js";
import { hash } from "../../packages/contracts/src/domain.js";

test("migration reconnects chains without touching the source and rejects ambiguous decisions or output dependencies", () => {
  const workflow = JSON.parse(
    readFileSync("examples/incident-staging.json", "utf8"),
  );
  workflow.edges.find((e: any) => e.target === "db").target = "old";
  workflow.nodes.push({
    id: "old",
    title: "legacy",
    type: "approval",
    config: {},
  });
  workflow.edges.push({ source: "old", target: "db", port: "next" });
  const before = hash(workflow);
  const copy = withoutLegacyNodes(workflow);
  assert.equal(
    copy.edges.find((e) => e.source === "need_db" && e.port === "true")!.target,
    "db",
  );
  assert.equal(hash(workflow), before);
  const ambiguous = structuredClone(workflow);
  ambiguous.edges.push({ source: "old", target: "end", port: "reject" });
  assert.throws(() => withoutLegacyNodes(ambiguous), {
    code: "MIGRATION_MANUAL_REQUIRED",
  });
  const referenced = structuredClone(workflow);
  referenced.nodes.find((n: any) => n.id === "synthesize").config.inputMappings[
    "/decision"
  ] = {
    ref: { source: "node", nodeId: "old", pointer: "/decision" },
  };
  assert.throws(() => withoutLegacyNodes(referenced), {
    code: "MIGRATION_MANUAL_REQUIRED",
  });
});
