import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import type { CallToolResult } from "@modelcontextprotocol/server";

// This layout is identical in the checkout and in the offline bundle.
export const projectRoot = fileURLToPath(
  new URL("../../../../", import.meta.url),
);
export const VERSION = "2.0.0-alpha.3";
export const RELEASE_PHASE = "ALPHA";
export const MODERN_PROTOCOL = "2026-07-28";
export const SDK_VERSION = "2.4.0";
export const EXECUTION_TOOL_NAMES = [
  "workflow_search",
  "workflow_get",
  "workflow_start",
  "workflow_advance",
  "workflow_status",
  "workflow_cancel",
  "artifact_read",
] as const;
export const TOOL_NAMES = [...EXECUTION_TOOL_NAMES,
  "host_scan", "host_scan_status", "capability_search", "capability_get", "capability_import",
  "workflow_draft_get", "workflow_draft_create", "workflow_draft_patch", "workflow_draft_validate", "workflow_draft_publish",
  "workflow_test_generate", "workflow_test_run", "workflow_test_status", "project_help_search"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];
export type Arguments = Record<string, unknown>;
export type ToolHandler = (
  name: ToolName,
  args: Arguments,
) => Promise<CallToolResult>;
export const inputContract = JSON.parse(
  readFileSync(
    resolve(projectRoot, "contracts/mcp-v2-tool-inputs.schema.json"),
    "utf8",
  ),
);
const ajv = new Ajv2020({ allErrors: true, strict: true });
const validators = new Map(
  TOOL_NAMES.map((name) => [name, ajv.compile(inputContract.$defs[name])]),
);

export function validArguments(
  name: ToolName,
  args: unknown,
): args is Arguments {
  return validators.get(name)!(args) as boolean;
}

export function result(
  data: Record<string, unknown>,
  isError = false,
): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(data) }],
    structuredContent: data,
    ...(isError ? { isError: true } : {}),
  };
}
export function failure(code: string, message: string, details?: unknown): CallToolResult {
  return result({ ok: false, error: { code, message, ...(details ? {details} : {}) } }, true);
}
