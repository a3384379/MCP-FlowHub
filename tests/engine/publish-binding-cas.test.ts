import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import Fastify from "fastify";
import { registerAdmin } from "../../packages/admin-api/src/index.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import {
  hash,
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";

test("publication binds the reviewed binding revisions and preserves previous immutable versions", async (t) => {
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo);
  vault.initialize("Synthetic-binding-publication-password-827");
  const engine = new Engine(repo, vault, new Connectors(repo, vault));
  const inputSchema = {
    type: "object",
    properties: {
      environment: { type: "string", const: "test" },
      resource: { type: "string" },
    },
    required: ["environment", "resource"],
    additionalProperties: false,
  };
  const outputSchema = {
    type: "object",
    properties: { environment: { const: "test" }, synthetic: { const: true } },
  };
  const schemaHash = "sha256:" + hash({ inputSchema, outputSchema });
  repo.insert("connections", "publication-fixture", {
    id: "publication-fixture",
    revision: 1,
    synthetic: true,
    disabled: false,
    catalogSafetyVersion: 1,
    tools: [{ name: "read", inputSchema, outputSchema, schemaHash }],
  });
  repo.insert("bindings", "reviewed-binding", {
    id: "reviewed-binding",
    revision: 1,
    connectionId: "publication-fixture",
    connectionRevision: 1,
    environment: "test",
    simulationOnly: true,
    validationStatus: "MOCK_VERIFIED",
    allowedTools: ["read"],
    allowedQueryTemplates: [],
    lockedArguments: {
      "/environment": "test",
      "/resource": "SYNTHETIC-RESOURCE-A",
    },
    maxRows: 100,
    timeoutSeconds: 5,
  });
  const workflow: Workflow = {
    schemaVersion: "flowhub.workflow/v1",
    workflowId: "publication-binding-cas",
    name: "Synthetic publication review",
    description: "In-process binding revision regression",
    version: "1.0.0",
    environment: "test",
    mode: "auto",
    tags: [],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    bindings: { source: "reviewed-binding" },
    nodes: [
      { id: "start", title: "Start", type: "input", config: {} },
      {
        id: "read",
        title: "Read",
        type: "mcp_tool",
        config: {
          bindingKey: "source",
          toolName: "read",
          toolSchemaHash: schemaHash,
          argumentsMappings: {},
        },
      },
      {
        id: "end",
        title: "End",
        type: "end",
        config: { resultRef: { ref: { source: "input", pointer: "" } } },
      },
    ],
    edges: [
      { source: "start", target: "read", port: "next" },
      { source: "read", target: "end", port: "next" },
    ],
    budgets: {
      maxRunSeconds: 30,
      maxToolCalls: 8,
      maxNodeExecutions: 32,
      maxAgentCheckpoints: 5,
      maxOutputBytes: 262144,
      maxRows: 100,
      maxToolSeconds: 5,
      maxRetries: 0,
    },
  };
  const directory = await mkdtemp(
    join(tmpdir(), "flowhub-binding-publication-"),
  );
  const app = Fastify();
  t.after(async () => {
    await engine.close();
    await app.close();
    db.close();
    await rm(directory, { recursive: true, force: true });
  });
  const { auth } = await registerAdmin(app, engine, directory);
  auth.setup("Synthetic-binding-publication-password-827");
  const session = auth.session();
  const api = async (
    path: string,
    payload: Json,
    method: "POST" | "PUT" = "POST",
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
  const saved = await api("/workflows", { workflow });
  assert.equal(saved.status, 200);
  const publicationPath = "/workflows/" + workflow.workflowId + "/publish";
  const first = await api(publicationPath, {
    expectedRevision: saved.data.revision,
    expectedBindingRevisions: { "reviewed-binding": 1 },
  });
  assert.equal(first.status, 200, JSON.stringify(first));
  const originalVersion = repo.get("versions", workflow.workflowId + "@1.0.0");
  workflow.version = "1.0.1";
  const candidate = await api(
    "/workflows/" + workflow.workflowId + "/draft",
    { workflow, layout: {} },
    "PUT",
    repo.get("workflows", workflow.workflowId).revision,
  );
  assert.equal(candidate.status, 200);
  const previewRevision = candidate.data.revision;
  const binding = repo.get("bindings", "reviewed-binding");
  repo.put(
    "bindings",
    binding.id,
    {
      ...binding,
      revision: 3,
      lockedArguments: {
        ...binding.lockedArguments,
        "/resource": "SYNTHETIC-RESOURCE-B",
      },
      maxRows: 5,
    },
    binding.revision,
  );
  assert.equal(
    repo.get("workflows", workflow.workflowId).revision,
    previewRevision,
  );
  assert.throws(
    () =>
      engine.publish(workflow.workflowId, previewRevision, "", {
        "reviewed-binding": 1,
      }),
    { code: "REVISION_CONFLICT" },
  );
  for (const body of [
    { expectedRevision: previewRevision },
    { expectedRevision: previewRevision, expectedBindingRevisions: null },
    { expectedRevision: previewRevision, expectedBindingRevisions: [] },
    {
      expectedRevision: previewRevision,
      expectedBindingRevisions: { "reviewed-binding": 0 },
    },
  ])
    assert.equal((await api(publicationPath, body)).status, 422);
  for (const expectedBindingRevisions of [
    {},
    { "reviewed-binding": 1 },
    { "reviewed-binding": 3, "unreviewed-extra": 1 },
  ]) {
    const denied = await api(publicationPath, {
      expectedRevision: previewRevision,
      expectedBindingRevisions,
    });
    assert.equal(denied.status, 409, JSON.stringify(denied));
    assert.equal(denied.error.code, "REVISION_CONFLICT");
    assert.equal(
      repo.get("versions", workflow.workflowId + "@1.0.1"),
      undefined,
    );
    assert.equal(
      repo.get("workflows", workflow.workflowId).revision,
      previewRevision,
    );
    assert.deepEqual(repo.get("versions", originalVersion.id), originalVersion);
  }
  const accepted = await api(publicationPath, {
    expectedRevision: previewRevision,
    expectedBindingRevisions: { "reviewed-binding": 3 },
  });
  assert.equal(accepted.status, 200, JSON.stringify(accepted));
  assert.equal(
    accepted.data.snapshot.bindings[0].lockedArguments["/resource"],
    "SYNTHETIC-RESOURCE-B",
  );
  assert.equal(accepted.data.snapshot.bindings[0].maxRows, 5);
  assert.deepEqual(repo.get("versions", originalVersion.id), originalVersion);
  const blank = structuredClone(workflow);
  blank.workflowId = "publication-without-bindings";
  blank.bindings = {};
  blank.nodes = blank.nodes.filter((node) => node.id !== "read");
  blank.edges = [{ source: "start", target: "end", port: "next" }];
  const blankSaved = await api("/workflows", { workflow: blank });
  assert.equal(blankSaved.status, 200);
  const blankPublished = await api(
    "/workflows/" + blank.workflowId + "/publish",
    {
      expectedRevision: blankSaved.data.revision,
      expectedBindingRevisions: {},
    },
  );
  assert.equal(blankPublished.status, 200, JSON.stringify(blankPublished));
  assert.deepEqual(blankPublished.data.snapshot.bindings, []);
});
