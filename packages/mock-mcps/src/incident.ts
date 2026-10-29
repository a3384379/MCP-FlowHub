import { fromJsonSchema, type McpServer } from "@modelcontextprotocol/server";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { projectRoot, result, failure } from "../../contracts/src/index.js";
import { mockSchemas, type Json } from "../../contracts/src/domain.js";
const order = { type: "string", pattern: "^DEMO-[A-Z0-9-]+$", maxLength: 64 };
export function registerIncidentTools(server: McpServer) {
  for (const [name, environment, project] of [
    ["aliyun_log_search", "production", "DEMO-LOG-PROD"],
    ["huawei_log_search", "staging", "DEMO-LOG-STAGING"],
  ]) {
    const schema = {
      type: "object",
      properties: {
        question: { type: "string", minLength: 1, maxLength: 2000 },
        orderNo: order,
        from: { type: "string", format: "date-time" },
        to: { type: "string", format: "date-time" },
        environment: { const: environment, type: "string" },
        project: { const: project, type: "string" },
      },
      required: ["question", "orderNo", "from", "to", "environment", "project"],
      additionalProperties: false,
    };
    server.registerTool(
      name!,
      {
        description: "合成日志，只接受固定环境和资源",
        inputSchema: fromJsonSchema<Json>(schema),
        outputSchema: fromJsonSchema({
          ...mockSchemas.$defs.logSearchResult,
          $defs: mockSchemas.$defs,
        }),
        annotations: { readOnlyHint: true },
      },
      async (args) => {
        const value = JSON.parse(
          readFileSync(
            resolve(projectRoot, "examples/mock-log-result.json"),
            "utf8",
          ),
        );
        value.environment = environment;
        for (const log of value.logs) log.orderNo = args.orderNo;
        return result(value);
      },
    );
  }
  const schema = {
    type: "object",
    properties: {
      templateId: { type: "string", const: "order-by-number-v1" },
      parameters: {
        type: "object",
        properties: { orderNo: order },
        required: ["orderNo"],
        additionalProperties: false,
      },
      environment: { type: "string", enum: ["production", "staging"] },
      connectionId: {
        type: "string",
        enum: ["DEMO-DB-PROD", "DEMO-DB-STAGING"],
      },
    },
    required: ["templateId", "parameters", "environment", "connectionId"],
    additionalProperties: false,
  };
  server.registerTool(
    "query_template",
    {
      description: "合成只读固定查询模板，环境与资源须一致",
      inputSchema: fromJsonSchema<Json>(schema),
      outputSchema: fromJsonSchema({
        ...mockSchemas.$defs.queryTemplateResult,
        $defs: mockSchemas.$defs,
      }),
      annotations: { readOnlyHint: true },
    },
    async (args) => {
      if (
        args.connectionId !==
        (args.environment === "production" ? "DEMO-DB-PROD" : "DEMO-DB-STAGING")
      )
        return failure("ENVIRONMENT_MISMATCH", "Synthetic resource mismatch.");
      const value = JSON.parse(
        readFileSync(
          resolve(projectRoot, "examples/mock-db-result.json"),
          "utf8",
        ),
      );
      value.environment = args.environment;
      for (const row of value.rows) {
        row.orderNo = args.parameters.orderNo;
        row.sentinel =
          args.environment === "production"
            ? "PROD_ONLY_SENTINEL_017"
            : "STAGE_ONLY_SENTINEL_029";
      }
      return result(value);
    },
  );
}
