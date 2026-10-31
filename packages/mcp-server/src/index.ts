import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  TOOL_NAMES,
  VERSION,
  inputContract,
  validArguments,
  failure,
  type Arguments,
  type ToolHandler,
  type ToolName,
} from "../../contracts/src/index.js";

/** Transport-specific server instances share ONE daemon-owned handler. */
export function createHubServer(handle: ToolHandler, names:readonly ToolName[]=TOOL_NAMES): McpServer {
  const server = new McpServer(
    { name: "mcp-flowhub", version: VERSION },
    {
      capabilities: { tools: {} },
      maxToolInputElements: 10000,
      instructions:
        "Run existing workflows: search → get → start. Author a workflow: capability_search/get → draft_create/patch → validate → test_generate/run/status → publish. Create, publish and run are distinct intents. Codex can propose fixtures without a model Key. Submit only the current checkpoint schema at WAITING_AGENT; host-only tools require actual Codex execution. Environment and resource bindings are immutable.",
    },
  );
  for (const name of names) {
    server.registerTool(
      name,
      {
        description: inputContract.$defs[name].description,
        inputSchema: fromJsonSchema<Arguments>(inputContract.$defs[name]),
        annotations: {
          readOnlyHint: [
            "workflow_search",
            "workflow_get",
            "workflow_status",
            "artifact_read",
            "host_scan_status", "capability_search", "capability_get", "workflow_draft_get", "workflow_draft_validate", "workflow_test_status", "project_help_search",
          ].includes(name),
        },
      },
      async (args) => {
        if (!validArguments(name, args))
          return failure(
            "INPUT_INVALID",
            "Arguments do not match the fixed tool contract.",
          );
        return handle(name, args);
      },
    );
  }
  return server;
}
