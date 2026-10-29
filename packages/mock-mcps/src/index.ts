import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { registerIncidentTools } from "./incident.js";
import { VERSION, result } from "../../contracts/src/index.js";
import { createLocalHttp } from "../../../apps/daemon/src/http.js";

export const mockInputSchema = {
  type: "object",
  properties: {
    orderNo: { type: "string", pattern: "^DEMO-[A-Za-z0-9-]{1,64}$" },
  },
  required: ["orderNo"],
  additionalProperties: false,
};
export const mockOutputSchema = {
  type: "object",
  properties: {
    synthetic: { const: true },
    environment: { const: "test" },
    sentinel: { const: "FLOWHUB_S0_TEST_ONLY_041" },
    orderNo: { type: "string" },
    message: { type: "string" },
  },
  required: ["synthetic", "environment", "sentinel", "orderNo", "message"],
  additionalProperties: false,
};

export function createMockServer(): McpServer {
  const server = new McpServer(
    { name: "flowhub-synthetic-mock", version: VERSION },
    { capabilities: { tools: {} } },
  );
  server.registerTool(
    "synthetic_order_lookup",
    {
      description:
        "Synthetic S0 test-only lookup; never connects to a database.",
      inputSchema: fromJsonSchema<{ orderNo: string }>(mockInputSchema),
      outputSchema: fromJsonSchema(mockOutputSchema),
      annotations: { readOnlyHint: true },
    },
    async ({ orderNo }) =>
      result({
        synthetic: true,
        environment: "test",
        sentinel: "FLOWHUB_S0_TEST_ONLY_041",
        orderNo,
        message: "合成订单 · 中文与 emoji ✅",
      }),
  );
  registerIncidentTools(server);
  return server;
}

export async function startMockHttp(token: string) {
  const app = createLocalHttp(createMockServer, token);
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: () => app.close(),
  };
}
