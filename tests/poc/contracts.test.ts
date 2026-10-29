import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { addFormats } from "@modelcontextprotocol/server/validators/ajv";

const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
for (const file of ["workflow", "mock-results", "mcp-tool-inputs"])
  ajv.addSchema(read(`contracts/${file}.schema.json`));

test("Draft 2020-12 standards validation: supplied workflows and binding catalog", () => {
  const schema = read("contracts/workflow.schema.json");
  const validate = ajv.getSchema(schema.$id)!;
  for (const env of ["production", "staging"]) {
    assert.equal(
      validate(read(`examples/incident-${env}.json`)),
      true,
      ajv.errorsText(validate.errors),
    );
  }
  const binding = ajv.compile({ $ref: `${schema.$id}#/$defs/bindingCatalog` });
  assert.equal(
    binding(read("examples/bindings.example.json")),
    true,
    ajv.errorsText(binding.errors),
  );
  const negative = read("examples/incident-production.json");
  negative.nodes[0].config.arbitraryCode = "forbidden";
  assert.equal(validate(negative), false);
});

test("Draft 2020-12: seven-tool contract rejects eighth tool and forged approval", () => {
  const schema = read("contracts/mcp-tool-inputs.schema.json");
  const validate = ajv.getSchema(schema.$id)!;
  assert.equal(
    validate({ tool: "workflow_search", arguments: { query: "排查" } }),
    true,
  );
  assert.equal(validate({ tool: "approve", arguments: {} }), false);
  assert.equal(
    validate({
      tool: "workflow_search",
      arguments: { query: "排查", environmentOverride: "production" },
    }),
    false,
  );
  assert.equal(
    validate({
      tool: "artifact_read",
      arguments: { runId: "r", artifactId: "a", path: "../../secret" },
    }),
    false,
  );
});

test("Draft 2020-12: supplied synthetic log/database results and negative control", () => {
  const schema = read("contracts/mock-results.schema.json");
  for (const [fixture, definition] of [
    ["mock-log-result", "logSearchResult"],
    ["mock-db-result", "queryTemplateResult"],
  ]) {
    const validate = ajv.compile({
      $ref: `${schema.$id}#/$defs/${definition}`,
    });
    const value = read(`examples/${fixture}.json`);
    assert.equal(validate(value), true, ajv.errorsText(validate.errors));
    value.synthetic = false;
    assert.equal(validate(value), false);
  }
});
