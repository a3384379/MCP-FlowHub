import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Repository, type Table } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import { createMockServer } from "../../packages/mock-mcps/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";

function fixture(records: Partial<Record<Table, Json[]>> = {}, mutate?: (repo: Repository) => void) {
  const db = new Database(":memory:"), repo = new Repository(db);
  for (const [table, items] of Object.entries(records))
    for (const item of items) repo.put(table as Table, item.id, structuredClone(item));
  mutate?.(repo);
  const vault = new Vault(repo), connectors = new Connectors(repo, vault);
  const http = createMcpHandler(createMockServer, { legacy: "stateless" });
  connectors.transport = () => new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
    fetch: (input, init) => http.fetch(new Request(input, init)),
  });
  const engine = new Engine(repo, vault, connectors);
  return { repo, engine, async close() { await engine.close(); await http.close(); db.close(); } };
}

test("legacy half-seed catalog quarantine recovers only unchanged built-in Mock scopes", async (t) => {
  const fresh = fixture();
  let connection: Json, binding: Json;
  try {
    await fresh.engine.seed();
    connection = fresh.repo.get("connections", "synthetic");
    binding = fresh.repo.all("bindings")[0];
    delete connection.catalogSafetyVersion;
  } finally { await fresh.close(); }
  for (const kind of ["unchanged", "revoked", "changed-scope"]) await t.test(kind, async () => {
    const f = fixture({ connections: [connection], bindings: [binding] }, (repo) => {
      const value = repo.get("bindings", binding.id);
      if (kind === "revoked") repo.put("bindings", value.id, { ...value, validationStatus: "REVOKED", revoked: true });
      if (kind === "changed-scope") repo.put("bindings", value.id, { ...value,
        lockedArguments: { ...value.lockedArguments, "/project": "MODIFIED_SYNTHETIC_RESOURCE" } });
    });
    try {
      const quarantined = f.repo.get("bindings", binding.id);
      assert.equal(quarantined.validationStatus, kind === "revoked" ? "REVOKED" : "UNVERIFIED");
      assert.equal(quarantined.verification, null);
      if (kind !== "unchanged") {
        await assert.rejects(f.engine.seed(), (error: any) => error.code === "SEED_CONFLICT");
        assert.equal(f.repo.get("settings", "seeded"), undefined);
        assert.deepEqual(f.repo.get("bindings", binding.id), quarantined);
      } else {
        await f.engine.seed();
        assert.ok(f.repo.get("settings", "seeded"));
        const current = f.repo.get("connections", "synthetic");
        for (const value of f.repo.all("bindings")) {
          assert.equal(value.validationStatus, "MOCK_VERIFIED");
          assert.equal(value.connectionRevision, current.revision);
        }
        assert.equal(f.repo.all("versions").length, 2);
      }
    } finally { await f.close(); }
  });
});
