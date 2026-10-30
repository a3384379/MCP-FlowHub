import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { McpServer, createMcpHandler } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";

const password = "Synthetic-catalog-regression-password-429";
const credential = "SYNTHETIC_CATALOG_CREDENTIAL_e417ef3";
const safeTool = () => ({
  name: "read_only",
  description: "Read approved synthetic data.",
  inputSchema: {
    type: "object",
    properties: { password: { type: "string" } },
    additionalProperties: false,
  },
  outputSchema: { type: "object", properties: {} },
});

function fixture(t: TestContext) {
  const db = new Database(":memory:");
  t.after(() => db.close());
  const repo = new Repository(db),
    vault = new Vault(repo);
  vault.initialize(password);
  const secret = vault.addSecret("synthetic catalog credential", credential);
  const connection = {
    id: "catalog-fixture",
    revision: 1,
    name: "Synthetic catalog fixture",
    transport: "streamable_http",
    protocolEra: "modern",
    disabled: false,
    synthetic: false,
    secretRef: secret.id,
    tools: [],
  };
  repo.insert("connections", connection.id, connection);
  const connectors = new Connectors(repo, vault);
  const catalog = async (
    tools: Json[],
    instructions = "Synthetic fixture.",
    beforeList?: () => void,
  ) => {
    const http = createMcpHandler(
      () => {
        const server = new McpServer(
          { name: "synthetic-catalog", version: "1" },
          {
            capabilities: { tools: {} },
            instructions,
          },
        );
        server.server.setRequestHandler("tools/list", async () => {
          beforeList?.();
          return { tools };
        });
        return server;
      },
      { legacy: "stateless" },
    );
    connectors.transport = () =>
      new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
        requestInit: { headers: { Authorization: "Bearer " + credential } },
        fetch: (input, init) => http.fetch(new Request(input, init)),
      });
    try {
      return await connectors.sync(connection.id);
    } finally {
      await http.close();
    }
  };
  return { repo, vault, connectors, connection, catalog };
}

test("real SDK catalog rejects credential echoes in schemas, descriptions, metadata and modern discovery before persistence", async (t) => {
  const { repo, catalog } = fixture(t);
  const safe = await catalog([safeTool()]);
  assert.equal(safe.catalogSafetyVersion, 1);
  assert.equal(safe.tools[0].inputSchema.properties.password.type, "string");
  const clean = JSON.stringify(repo.all("connections"));
  const candidates: Json[] = [
    { ...safeTool(), description: "opaque<" + credential + ">" },
    { ...safeTool(), name: credential },
    {
      ...safeTool(),
      inputSchema: {
        type: "object",
        properties: { value: { const: credential } },
      },
    },
    {
      ...safeTool(),
      outputSchema: {
        type: "object",
        properties: { value: { enum: [credential] } },
      },
    },
    { ...safeTool(), _meta: { diagnostic: credential } },
    { ...safeTool(), _meta: { apiKey: "UNREGISTERED_SYNTHETIC_KEY" } },
  ];
  for (const tool of candidates) {
    await assert.rejects(catalog([tool]), { code: "CATALOG_SENSITIVE" });
    assert.equal(JSON.stringify(repo.all("connections")), clean);
  }
  await assert.rejects(catalog([safeTool()], "opaque<" + credential + ">"), {
    code: "CATALOG_SENSITIVE",
  });
  assert.equal(JSON.stringify(repo.all("connections")), clean);
  assert.equal(clean.includes(credential), false);
});

test("catalog discovery fails closed when the vault locks or its credential context changes across the SDK exchange", async (t) => {
  const { repo, vault, catalog } = fixture(t);
  for (const unlockAgain of [false, true]) {
    if (vault.locked) vault.unlock(password);
    await assert.rejects(
      catalog([safeTool()], undefined, () => {
        vault.lock();
        if (unlockAgain) vault.unlock(password);
      }),
      { code: "CREDENTIAL_LOCKED" },
    );
    assert.deepEqual(repo.get("connections", "catalog-fixture").tools, []);
  }
  vault.lock();
  await assert.rejects(catalog([safeTool()]), { code: "CREDENTIAL_LOCKED" });
});

test("schema changes invalidate verified bindings and connection revisions atomically; unchanged catalogs retain verification", async (t) => {
  const { repo, catalog } = fixture(t);
  const first = await catalog([safeTool()]);
  repo.insert("bindings", "verified", {
    id: "verified",
    revision: 4,
    connectionId: first.id,
    connectionRevision: first.revision,
    validationStatus: "BINDING_VERIFIED",
    verification: { scope: "synthetic regression" },
  });
  await catalog([safeTool()]);
  assert.equal(
    repo.get("bindings", "verified").validationStatus,
    "BINDING_VERIFIED",
  );
  const changed = safeTool();
  changed.inputSchema.properties.password.type = "integer";
  const next = await catalog([changed]);
  assert.equal(next.revision, first.revision + 1);
  assert.equal(next.verifiedRevision, next.revision);
  const binding = repo.get("bindings", "verified");
  assert.equal(binding.validationStatus, "UNVERIFIED");
  assert.equal(binding.revision, 5);
  assert.equal(binding.verification, null);
  assert.notEqual(binding.connectionRevision, next.revision);
});

test("startup quarantines uninspected historical catalogs while the vault is locked", (t) => {
  const { repo, vault } = fixture(t);
  const previous = repo.get("connections", "catalog-fixture");
  repo.put("connections", previous.id, {
    ...previous,
    tools: [{ ...safeTool(), description: credential }],
    discovery: { instructions: credential },
    verifiedAt: new Date().toISOString(),
    history: [{ diagnostic: credential }],
  });
  repo.insert("bindings", "old-verification", {
    id: "old-verification",
    revision: 2,
    connectionId: previous.id,
    validationStatus: "BINDING_VERIFIED",
  });
  vault.lock();
  const restarted = new Connectors(repo, vault);
  assert.equal(
    JSON.stringify(repo.all("connections")).includes(credential),
    false,
  );
  assert.equal(
    repo.get("connections", previous.id).revision,
    previous.revision + 1,
  );
  assert.equal(
    repo.get("bindings", "old-verification").validationStatus,
    "UNVERIFIED",
  );
  assert.deepEqual(
    restarted.catalogView({
      ...previous,
      tools: [{ description: credential }],
      discovery: { instructions: credential },
    }).tools,
    [],
  );
});

test("vault password rotation rewraps checkpoint delivery and operational outputs on the same run", (t) => {
  const { repo, vault } = fixture(t);
  repo.insert("runs", "rotation-fixture", {
    id: "rotation-fixture",
    revision: 1,
    checkpoint: {
      id: "checkpoint",
      delivery: vault.encrypt(
        "checkpoint delivery",
        "rotation-fixture:checkpoint",
      ),
    },
    operationalOutputs: {
      read: vault.encrypt(
        "raw operational value",
        "rotation-fixture:output:read",
      ),
    },
  });
  const before = repo.get("runs", "rotation-fixture");
  const put = repo.put.bind(repo);
  repo.put = (table, id, value, expected) => {
    if (table === "settings" && id === "vault")
      throw new Error("Synthetic rotation transaction failure");
    return put(table, id, value, expected);
  };
  try {
    assert.throws(
      () =>
        vault.changePassword(
          password,
          "Synthetic-failed-rotation-password-662",
        ),
      /Synthetic rotation transaction failure/,
    );
    assert.deepEqual(repo.get("runs", "rotation-fixture"), before);
    vault.lock();
    vault.unlock(password);
    assert.equal(
      vault.decrypt(
        before.operationalOutputs.read,
        "rotation-fixture:output:read",
      ),
      "raw operational value",
    );
  } finally {
    repo.put = put;
  }
  vault.changePassword(password, "Synthetic-rotated-regression-password-582");
  vault.lock();
  vault.unlock("Synthetic-rotated-regression-password-582");
  const run = repo.get("runs", "rotation-fixture");
  assert.equal(
    vault.decrypt(run.checkpoint.delivery, "rotation-fixture:checkpoint"),
    "checkpoint delivery",
  );
  assert.equal(
    vault.decrypt(run.operationalOutputs.read, "rotation-fixture:output:read"),
    "raw operational value",
  );
});
