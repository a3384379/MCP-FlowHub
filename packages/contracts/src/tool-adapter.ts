import {
  ensure,
  get,
  set,
  parts,
  hash,
  validate,
  type Json,
} from "./domain.js";
import { assertSafeSchemaPatterns, walkSchema } from "./schema-safety.js";

export const toolAdaptersSchema = {
  type: "object",
  maxProperties: 100,
  additionalProperties: {
    type: "object",
    additionalProperties: false,
    properties: {
      version: { const: 1 },
      format: { enum: ["structured", "text_json"] },
      payloadSchema: { type: "object" },
      environment: {
        oneOf: [
          {
            type: "object",
            properties: {
              source: { const: "payload" },
              pointer: { type: "string", pattern: "^/" },
            },
            required: ["source", "pointer"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: { source: { const: "binding" } },
            required: ["source"],
            additionalProperties: false,
          },
        ],
      },
      rowLimit: {
        oneOf: [
          {
            type: "object",
            properties: { argumentPointer: { type: "string", pattern: "^/" } },
            required: ["argumentPointer"],
            additionalProperties: false,
          },
          {
            type: "object",
            properties: {
              serverMaxRows: { type: "integer", minimum: 1, maximum: 1000 },
              attestation: { type: "string", minLength: 1, maxLength: 1000 },
            },
            required: ["serverMaxRows", "attestation"],
            additionalProperties: false,
          },
        ],
      },
    },
    required: ["version", "format", "environment"],
  },
};
export function adapterFor(binding: Json, toolName: string): Json | undefined {
  if (binding.toolAdapters !== undefined)
    validate(toolAdaptersSchema, binding.toolAdapters);
  const adapter = binding.toolAdapters?.[toolName];
  if (adapter?.environment.pointer) parts(adapter.environment.pointer);
  if (adapter?.rowLimit?.argumentPointer) {
    const pointer = adapter.rowLimit.argumentPointer;
    parts(pointer);
    ensure(
      !Object.keys(binding.lockedArguments ?? {}).some(
        (locked) =>
          locked === pointer ||
          locked.startsWith(pointer + "/") ||
          pointer.startsWith(locked + "/"),
      ),
      "ENVIRONMENT_OVERRIDE_DENIED",
      "The row-limit parameter cannot overlap a locked environment or resource parameter.",
    );
  }
  return adapter;
}
export function payloadSchema(binding: Json, tool: Json) {
  const adapter = adapterFor(binding, tool.name);
  if (adapter?.payloadSchema) {
    assertSafeSchemaPatterns(adapter.payloadSchema);
    walkSchema(adapter.payloadSchema, (node) => {
      if (node && typeof node === "object")
        ensure(
          !node.$dynamicRef &&
            !node.$recursiveRef &&
            (!node.$ref || node.$ref.startsWith("#/")),
          "SCHEMA_INVALID",
          "Adapter schemas allow bounded local references only.",
        );
    });
  }
  return adapter?.payloadSchema ?? tool.outputSchema;
}
export function applyRowBudget(
  binding: Json,
  toolName: string,
  args: Json,
  workflowMaxRows: number,
) {
  const limit = Math.min(binding.maxRows, workflowMaxRows),
    adapter = adapterFor(binding, toolName);
  ensure(
    Number.isSafeInteger(limit) && limit > 0,
    "BUDGET_EXCEEDED",
    "Invalid effective row budget.",
  );
  if (!adapter?.rowLimit) {
    ensure(
      binding.environment !== "production" || binding.simulationOnly,
      "ROW_LIMIT_UNVERIFIED",
      "Production tools require an explicit argument limit or independently verified server limit.",
    );
    return args;
  }
  const policy = adapter.rowLimit;
  if (policy.argumentPointer) {
    let value;
    try {
      value = get(args, policy.argumentPointer);
    } catch (e: any) {
      if (e.code !== "REFERENCE_MISSING") throw e;
    }
    if (value === undefined) set(args, policy.argumentPointer, limit);
    else
      ensure(
        Number.isSafeInteger(value) && value > 0 && value <= limit,
        "BUDGET_EXCEEDED",
        "The requested row limit exceeds the effective approved budget.",
      );
  } else
    ensure(
      policy.serverMaxRows <= limit &&
        (binding.simulationOnly ||
          binding.verification?.serverMaxRows === policy.serverMaxRows),
      "ROW_LIMIT_UNVERIFIED",
      "The verified server row limit cannot enforce this workflow's smaller budget.",
    );
  return args;
}
export function decodeToolResult(
  binding: Json,
  tool: Json,
  result: Json,
): Json {
  ensure(!result.isError, "TOOL_FAILED", "Downstream tool returned an error.");
  ensure(
    Buffer.byteLength(JSON.stringify(result)) <= 262144,
    "OUTPUT_INVALID",
    "Downstream result exceeds the supported adapter byte limit.",
  );
  const adapter = adapterFor(binding, tool.name);
  let out: Json;
  if (adapter?.format === "text_json") {
    ensure(
      result.structuredContent === undefined &&
        !tool.outputSchema &&
        Array.isArray(result.content) &&
        result.content.length === 1 &&
        result.content[0].type === "text" &&
        typeof result.content[0].text === "string" &&
        adapter.payloadSchema,
      "OUTPUT_INVALID",
      "Text JSON requires one text block, an explicit payload Schema and no structured-output declaration.",
    );
    try {
      out = JSON.parse(result.content[0].text);
    } catch {
      ensure(
        false,
        "OUTPUT_INVALID",
        "The single text block is not valid JSON.",
      );
    }
  } else out = result.structuredContent;
  ensure(
    out && typeof out === "object" && !Array.isArray(out),
    "OUTPUT_INVALID",
    "The selected adapter requires an object payload.",
  );
  if (tool.outputSchema) validate(tool.outputSchema, out);
  const schema = payloadSchema(binding, tool);
  ensure(
    !adapter || schema,
    "OUTPUT_INVALID",
    "An adapted result requires an explicit business output Schema.",
  );
  if (schema) validate(schema, out);
  const environment = adapter?.environment ?? {
    source: "payload",
    pointer: "/environment",
  };
  if (environment.source === "payload")
    ensure(
      get(out, environment.pointer) === binding.environment,
      "ENVIRONMENT_MISMATCH",
      "Downstream environment evidence differs from the frozen binding.",
    );
  else
    ensure(
      binding.verification?.sourceAttestation &&
        binding.verification.sourceAttestation.environment ===
          binding.environment &&
        binding.verification.sourceAttestation.connectionRevision ===
          binding.connectionRevision &&
        binding.verification.sourceAttestation.bindingRevision ===
          binding.revision &&
        binding.verification.sourceAttestation.adapterHash ===
          hash(binding.toolAdapters),
      "BINDING_UNVERIFIED",
      "Payload-free environment evidence requires verified endpoint, service, account and resource attestation.",
    );
  if (Object.hasOwn(out, "environment"))
    ensure(
      out.environment === binding.environment,
      "ENVIRONMENT_MISMATCH",
      "Payload contradicts the verified environment.",
    );
  if (binding.simulationOnly)
    ensure(
      out.synthetic === true,
      "ENVIRONMENT_MISMATCH",
      "A synthetic binding requires explicit synthetic provenance.",
    );
  if (Array.isArray(out.rows))
    ensure(
      out.rowCount === undefined || out.rowCount === out.rows.length,
      "OUTPUT_INVALID",
      "Row count does not match actual rows.",
    );
  return out;
}
