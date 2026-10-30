import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import {
  TOOL_NAMES,
  VERSION,
  inputContract,
  validArguments,
  failure,
  type Arguments,
  type ToolHandler,
} from "../../contracts/src/index.js";

/** Transport-specific server instances share ONE daemon-owned handler. */
export function createHubServer(handle: ToolHandler): McpServer {
  const server = new McpServer(
    { name: "mcp-flowhub", version: VERSION },
    {
      capabilities: { tools: {} },
      maxToolInputElements: 10000,
      instructions:
        "Search and get a published workflow, supply its exact version and required input, then start. Submit only the current checkpoint schema at WAITING_AGENT. WAITING_APPROVAL requires independent administrator action; execution tools cannot approve. Environment and resource bindings are immutable.",
    },
  );
  for (const name of TOOL_NAMES) {
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
