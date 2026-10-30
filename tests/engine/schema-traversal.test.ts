import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import {
  assertSafeSchemaPatterns,
  walkSchema,
} from "../../packages/contracts/src/schema-safety.js";
import {
  validate,
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";
import { validateWorkflow } from "../../packages/workflow-core/src/validate.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Connectors } from "../../packages/mcp-connectors/src/registry.js";

const unsafe = "^(a+)+$";
const inert = { pattern: unsafe, $ref: "https://example.invalid/inert-data" };
const businessSchema = () => ({
  type: "object",
  properties: {
    ...Object.fromEntries(
      [
        "pattern",
        "$ref",
        "format",
        "const",
        "patternProperties",
        "properties",
        "$defs",
        "examples",
        "default",
        "dependencies",
        "items",
      ].map((name) => [name, { type: "string" }]),
    ),
    literal: {
      type: "object",
      properties: { pattern: { type: "string" }, $ref: { type: "string" } },
      required: ["pattern", "$ref"],
      additionalProperties: false,
      const: inert,
      examples: [inert],
    },
  },
  required: ["pattern", "$ref"],
  additionalProperties: false,
  examples: [
    { pattern: "business text", $ref: "business reference", literal: inert },
  ],
});
function workflow(): Workflow {
  return {
    schemaVersion: "flowhub.workflow/v1",
    workflowId: "schema-keyword-fields",
    name: "Synthetic keyword fields",
    description: "Schema traversal boundary regression",
    version: "1.0.0",
    environment: "test",
    mode: "guided",
    tags: [],
    inputSchema: businessSchema(),
    bindings: {},
    nodes: [
      { id: "start", title: "Input", type: "input", config: {} },
      {
        id: "analysis",
        title: "Analysis",
        type: "agent_task",
        config: {
          kind: "analysis",
          instructions: "Return synthetic keyword fields.",
          inputMappings: {},
          outputSchema: businessSchema(),
        },
      },
      {
        id: "end",
        title: "End",
        type: "end",
        config: {
          resultRef: {
            ref: { source: "node", nodeId: "analysis", pointer: "" },
          },
        },
      },
    ],
    edges: [
      { source: "start", target: "analysis", port: "next" },
      { source: "analysis", target: "end", port: "next" },
    ],
    budgets: {
      maxRunSeconds: 30,
      maxToolCalls: 1,
      maxNodeExecutions: 8,
      maxAgentCheckpoints: 1,
      maxOutputBytes: 262144,
      maxRows: 100,
      maxToolSeconds: 5,
      maxRetries: 0,
    },
  };
}

test("schema-keyword business fields and inert literal data remain valid in workflow input and Agent output", () => {
  const schema = businessSchema();
  assertSafeSchemaPatterns(schema);
  validate(schema, schema.examples[0]);
  const visited: Json[] = [];
  walkSchema({ ...schema, default: inert, "x-annotation": inert }, (node) =>
    visited.push(node),
  );
  assert.equal(visited.includes(inert), false);
  assert.equal(visited.includes(schema.properties), false);
  assert.equal(validateWorkflow(workflow(), [], []).ok, true);
  for (const location of ["input", "agent"]) {
    const candidate = workflow();
    const schema =
      location === "input"
        ? candidate.inputSchema
        : candidate.nodes[1]!.config.outputSchema;
    schema.properties.pattern.pattern = unsafe;
    assert.throws(() => validateWorkflow(candidate, [], []), {
      code: "SCHEMA_INVALID",
    });
  }
});

test("every real schema position retains regex checks while literal data is bounded and inert", () => {
  const bad = { type: "string", pattern: unsafe };
  const candidates: Json[] = [
    ...[
      "properties",
      "$defs",
      "definitions",
      "dependentSchemas",
      "dependencies",
    ].map((keyword) => ({ [keyword]: { pattern: bad } })),
    ...["allOf", "anyOf", "oneOf", "prefixItems"].map((keyword) => ({
      [keyword]: [bad],
    })),
    ...[
      "additionalProperties",
      "unevaluatedProperties",
      "additionalItems",
      "unevaluatedItems",
      "contains",
      "propertyNames",
      "not",
      "if",
      "then",
      "else",
      "contentSchema",
      "items",
    ].map((keyword) => ({ [keyword]: bad })),
    { items: [bad] },
    { patternProperties: { [unsafe]: { type: "string" } } },
    { patternProperties: { "^safe$": bad } },
  ];
  for (const schema of candidates)
    assert.throws(() => assertSafeSchemaPatterns(schema), {
      code: "SCHEMA_INVALID",
    });
  assertSafeSchemaPatterns({
    type: "object",
    const: inert,
    enum: [inert],
    examples: [inert],
    default: inert,
    "x-annotation": inert,
    dependencies: { property: ["pattern", "$ref"] },
  });
  assertSafeSchemaPatterns({ allOf: [true, false] });
  assert.throws(
    () =>
      assertSafeSchemaPatterns({
        examples: Array.from({ length: 2049 }, () => null),
      }),
    { code: "SCHEMA_LIMIT" },
  );
  assert.throws(
    () => assertSafeSchemaPatterns({ description: "x".repeat(131072) }),
    { code: "SCHEMA_LIMIT" },
  );
  let nested: Json = null;
  for (let i = 0; i < 25; i++) nested = { nested };
  assert.throws(() => assertSafeSchemaPatterns({ const: nested }), {
    code: "SCHEMA_LIMIT",
  });
});

test("official SDK discovery accepts keyword field names and inert annotations but rejects actual regex and remote references", async (t) => {
  const db = new Database(":memory:"),
    repo = new Repository(db),
    vault = new Vault(repo),
    connectors = new Connectors(repo, vault);
  let inputSchema: Json = businessSchema(),
    outputSchema: Json = businessSchema();
  const downstream = createMcpHandler(
    () => {
      const server = new McpServer(
        { name: "synthetic-schema-traversal", version: "1" },
        { capabilities: { tools: {} } },
      );
      server.server.setRequestHandler("tools/list", async () => ({
        tools: [{ name: "read", inputSchema, outputSchema }],
      }));
      return server;
    },
    { legacy: "stateless" },
  );
  connectors.transport = () =>
    new StreamableHTTPClientTransport(new URL("http://127.0.0.1/mcp"), {
      fetch: (input, init) => downstream.fetch(new Request(input, init)),
    });
  t.after(async () => {
    await downstream.close();
    db.close();
  });
  const connection = {
    id: "schema-traversal",
    revision: 1,
    protocolEra: "modern",
    synthetic: true,
    tools: [],
  };
  const safe = await connectors.discover(connection);
  assert.deepEqual(safe.tools[0].inputSchema, businessSchema());
  assert.deepEqual(safe.tools[0].outputSchema, businessSchema());
  inputSchema = { ...businessSchema(), default: inert, "x-annotation": inert };
  await connectors.discover(connection);
  for (const location of ["input", "output"]) {
    for (const bad of [
      {
        type: "object",
        properties: { pattern: { type: "string", pattern: unsafe } },
      },
      { type: "object", patternProperties: { [unsafe]: { type: "string" } } },
      {
        type: "object",
        $defs: { pattern: { $ref: "https://example.invalid/real-schema" } },
      },
      {
        type: "object",
        dependentSchemas: { $ref: { $dynamicRef: "#dynamic" } },
      },
    ]) {
      inputSchema = location === "input" ? bad : businessSchema();
      outputSchema = location === "output" ? bad : businessSchema();
      await assert.rejects(connectors.discover(connection), {
        code: "SCHEMA_INVALID",
      });
      assert.equal(repo.get("connections", connection.id), undefined);
    }
  }
});
