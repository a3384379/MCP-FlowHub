import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import Fastify from "fastify";
import {
  createMcpHandler,
  McpServer,
  fromJsonSchema,
} from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { registerAdmin } from "../../packages/admin-api/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import type { Json } from "../../packages/contracts/src/domain.js";
import { sourceConnectionRouteHash } from "../../packages/contracts/src/source-connection.js";

test("connection PATCH clears the catalog baseline while live schema drift still invalidates the first verification", async (t) => {
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo);
  const password = "Synthetic-config-reset-password-672";
  const credential = "SYNTHETIC_CONFIG_RESET_CREDENTIAL_277cf";
  vault.initialize(password);
  const secret = vault.addSecret("synthetic catalog reset", credential);
  const connectors = new Connectors(repo, vault),
    engine = new Engine(repo, vault, connectors);
  const log: string[] = [];
  const app = Fastify({
    logger: {
      level: "info",
      stream: {
        write: (line: string) => {
          log.push(line);
        },
      },
    },
  });
  const directory = await mkdtemp(join(tmpdir(), "flowhub-catalog-reset-"));
  let schemaRevision = 1,
    calls = 0,
    description = "Synthetic approved read.";
  const downstream = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "synthetic-catalog-reset", version: "1" },
        { capabilities: { tools: {} } },
      );
      server.registerTool(
        "safe_read",
        {
          description,
          inputSchema: fromJsonSchema({
            type: "object",
            properties: {
              environment: { const: "production" },
              ...(schemaRevision === 2
                ? { includeArchived: { type: "boolean" } }
                : {}),
            },
            required: ["environment"],
            additionalProperties: false,
          }),
        },
        async () => {
          calls++;
          return {
            content: [],
            structuredContent: { environment: "production", synthetic: true },
          };
        },
      );
      return server;
    },
    { legacy: "stateless" },
  );
  connectors.transport = () =>
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      requestInit: { headers: { Authorization: "Bearer " + credential } },
      fetch: (input, init) => downstream.fetch(new Request(input, init)),
    });
  t.after(async () => {
    await engine.close();
    await app.close();
    await downstream.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { auth } = await registerAdmin(app, engine, directory);
  auth.setup(password);
  const session = auth.session();
  const api = async (
    path: string,
    payload: Json,
    method: "POST" | "PATCH" = "POST",
    revision?: number,
  ) => {
    const response = await app.inject({
      method,
      url: "/api/v1" + path,
      payload,
      headers: {
        cookie: "flowhub_session=" + session.token,
        "x-csrf-token": session.csrf,
        ...(revision === undefined ? {} : { "if-match": String(revision) }),
      },
    });
    return { status: response.statusCode, ...response.json<Json>() };
  };
  const connection = await api("/connections", {
    name: "synthetic catalog reset",
    transport: "streamable_http",
    protocolEra: "modern",
    endpoint: "http://127.0.0.1:1/mcp",
    allowedHosts: ["127.0.0.1"],
    secretRef: secret.id,
  });
  assert.equal(connection.status, 200);
  const binding = await api("/bindings", {
    name: "synthetic reset binding",
    connectionId: connection.data.id,
    environment: "production",
    allowedTools: ["safe_read"],
    lockedArguments: { "/environment": "production" },
    allowedQueryTemplates: [],
    maxRows: 1,
    timeoutSeconds: 5,
  });
  assert.equal(binding.status, 200);
  const verification = {
    probe: { toolName: "safe_read", arguments: { environment: "production" } },
    serverEnforcedReadOnly: true,
    scope: "Local synthetic reset regression",
    expectedEnvironmentPointer: "/environment",
  };
  const verify = () =>
    api("/bindings/" + binding.data.id + "/verify", verification);
  assert.equal((await verify()).status, 200);
  assert.equal(calls, 1);
  schemaRevision = 2;
  const drift = await verify();
  assert.equal(drift.status, 409);
  assert.equal(drift.error.code, "BINDING_REVOKED");
  assert.equal(calls, 1);
  assert.equal((await verify()).status, 200);
  assert.equal(calls, 2);
  const before = repo.get("connections", connection.data.id);
  assert.equal(before.catalogSafetyVersion, 1);
  assert.ok(before.discovery);
  assert.ok(before.history.length);
  const discoveredLink = {
    sourceId: "synthetic-source",
    sourceFingerprint: "synthetic-fingerprint",
    sourceRouteHash: sourceConnectionRouteHash(before),
    catalogFingerprint: "synthetic-catalog",
  };
  repo.put("connections", before.id, { ...before, ...discoveredLink }, before.revision);
  const oldBinding = repo.get("bindings", binding.data.id);
  repo.put("bindings", oldBinding.id, { ...oldBinding, sourceCapabilityId: "synthetic-read", sourceCapabilityRevision: 1 },
    oldBinding.revision);
  const disabled = await api(
    "/connections/" + connection.data.id,
    { disabled: true },
    "PATCH",
    before.revision,
  );
  assert.equal(disabled.status, 200);
  for (const field of [
    "catalogSafetyVersion",
    "discovery",
    "history",
    "verifiedRevision",
  ])
    assert.equal(Object.hasOwn(disabled.data, field), false, field);
  assert.deepEqual(disabled.data.tools, []);
  for (const [key, value] of Object.entries(discoveredLink)) assert.equal(disabled.data[key], value);
  assert.equal(repo.get("bindings", oldBinding.id).sourceCapabilityId, "synthetic-read");
  const restored = await api(
    "/connections/" + connection.data.id,
    { disabled: false },
    "PATCH",
    disabled.data.revision,
  );
  assert.equal(restored.status, 200);
  const accepted = await verify();
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(calls, 3);
  assert.equal(accepted.data.connectionRevision, restored.data.revision);
  assert.equal(
    repo.get("connections", connection.data.id).revision,
    restored.data.revision,
  );
  description = "opaque<" + credential + ">";
  const rejected = await api(
    "/connections/" + connection.data.id + "/sync-tools",
    {},
  );
  assert.equal(rejected.status, 422);
  assert.equal(rejected.error.code, "CATALOG_SENSITIVE");
  assert.equal(JSON.stringify(rejected).includes(credential), false);
  assert.equal(log.join("").includes(credential), false);
  assert.equal(
    JSON.stringify(repo.get("connections", connection.data.id)).includes(
      credential,
    ),
    false,
  );
  const changedRoute = await api(
    "/connections/" + connection.data.id,
    { endpoint: "http://127.0.0.1:2/mcp" },
    "PATCH",
    repo.get("connections", connection.data.id).revision,
  );
  assert.equal(changedRoute.status, 200);
  for (const key of Object.keys(discoveredLink)) assert.equal(Object.hasOwn(changedRoute.data, key), false, key);
  const invalidated = repo.get("bindings", oldBinding.id);
  assert.equal(invalidated.connectionId, before.id);
  assert.equal(invalidated.validationStatus, "UNVERIFIED");
  assert.equal(invalidated.verification, null);
  assert.equal(Object.hasOwn(invalidated, "sourceCapabilityId"), false);
  assert.deepEqual(repo.get("connections", before.id).tools, []);
});
