import { readFile, mkdir, writeFile } from "node:fs/promises";
// This reads only our route declarations. It does not evaluate application code.
const source = (await Promise.all(["packages/admin-api/src/index.ts", "packages/admin-api/src/v2.ts"].map(p=>readFile(p,"utf8")))).join("\n");
const declarations = [
  ...source.matchAll(/app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g),
];
const paths = {};
for (let i = 0; i < declarations.length; i++) {
  const match = declarations[i],
    method = match[1],
    route = match[2];
  if (!/^\/api\/v[12]\//.test(route)) continue;
  const code = source.slice(
      match.index,
      declarations[i + 1]?.index ?? source.length,
    ),
    path = route.replace(/:([A-Za-z]+)/g, "{$1}");
  const publicRoute =
    route === "/api/v1/auth/state" ||
    route === "/api/v1/auth/bootstrap" ||
    (["/api/v1/auth/session", "/api/v1/auth/local-session", "/api/v1/auth/codex-session"].includes(route) && method === "post");
  const parameters = [...route.matchAll(/:([A-Za-z]+)/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: { type: "string" },
  }));
  if (method !== "get" && !publicRoute)
    parameters.push({
      name: "X-CSRF-Token",
      in: "header",
      required: true,
      schema: { type: "string" },
    });
  if (["/api/v1/auth/local-session", "/api/v1/auth/codex-session"].includes(route))
    parameters.push(
      { name: "Origin", in: "header", required: true, schema: { type: "string" } },
      { name: "X-FlowHub-Local", in: "header", required: true, schema: { const: "1" } },
    );
  if (code.includes("revision(req)") || code.includes('req.headers["if-match"]'))
    parameters.push({
      name: "If-Match",
      in: "header",
      required: true,
      schema: { type: "integer", minimum: 1 },
    });
  const operation = {
    summary: method.toUpperCase() + " " + route,
    security: publicRoute ? [] : [{ adminSession: [] }],
    parameters,
    responses: {
      200: {
        description: "Success envelope",
        content: {
          "application/json": {
            schema: { $ref: "#/components/schemas/ApiResponse" },
          },
        },
      },
      401: { description: "Authentication required" },
      403: { description: "Origin, scope or CSRF denied" },
      409: { description: "Revision/idempotency/version conflict" },
      422: { description: "Schema/domain validation failed" },
      429: { description: "Rate limited" },
    },
  };
  if (route === "/api/v1/auth/local-session")
    operation.description = "Open a local browser session from the exact loopback origin without an account. Returns CSRF and sets an HttpOnly cookie.";
  if (route === "/api/v1/auth/codex-session")
    operation.description = "Redeem a one-time local Codex sidebar ticket for a partitioned management session.";
  if (route === "/api/v1/auth/bootstrap" || route === "/api/v1/auth/session" && method === "post")
    operation.deprecated = true;
  const body = code.match(/body\(\s*req,\s*(\[[^\]]*\])(?:,\s*(\[[^\]]*\]))?/);
  if (body) {
    const fields = (s) =>
        [...(s ?? "").matchAll(/["']([^"']+)["']/g)].map((m) => m[1]),
      required = fields(body[1]),
      optional = fields(body[2]);
    operation.requestBody = {
      required: true,
      content: {
        "application/json": {
          schema: {
            type: "object",
            required,
            properties: Object.fromEntries(
              [...required, ...optional].map((k) => [k, {}]),
            ),
            additionalProperties: false,
          },
        },
      },
    };
  }
  if (route === "/api/v2/workflows/:id" && method === "delete") {
    const schema = JSON.parse(await readFile("contracts/workflow-delete.schema.json", "utf8"));
    operation.requestBody = {required:true,content:{"application/json":{schema}}};
    operation.responses[404] = {description:"Workflow missing or already deleted (except exact idempotent replay)"};
    operation.responses[428] = {description:"If-Match and expectedRevision must agree"};
    operation.summary = "Delete a workflow from the library; preserve published snapshots and execution history";
  }
  if(method==="post" && ["/api/v2/workflows/:id/test-suites","/api/v2/test-suites/:id/runs"].includes(route)) {
    const definitions=JSON.parse(await readFile("contracts/mcp-v2-tool-inputs.schema.json","utf8")).$defs;
    const schema=structuredClone(definitions[route.endsWith("/runs")?"workflow_test_run":"workflow_test_generate"]);
    const pathKey=route.endsWith("/runs")?"suiteId":"workflowId";
    delete schema.properties[pathKey];schema.required=schema.required.filter(key=>key!==pathKey);
    operation.requestBody={required:true,content:{"application/json":{schema}}};
  }
  if (route.endsWith("/events"))
    operation.responses[200] = {
      description: "Authenticated event stream; Last-Event-ID or after cursor",
      content: { "text/event-stream": { schema: { type: "string" } } },
    };
  const artifactRoute = "/api/v1/runs/:id/artifacts/:artifactId";
  if (route === artifactRoute || route === artifactRoute + "/download") {
    parameters.push({
      name: "format", in: "query", required: false, schema: { const: "html" },
      description: "Request an offline HTML rendition of a Markdown or FlowHub report. Omit for original content.",
    });
    operation.responses[404] = { description: "Run or artifact missing, expired, or outside the selected run" };
  }
  if (route === artifactRoute + "/download") {
    operation.summary = "Download the complete original artifact or its requested HTML rendition";
    operation.responses[200] = {
      description: "Original or rendered HTML bytes with Content-Disposition attachment",
      content: { "application/octet-stream": { schema: { type: "string", format: "binary" } } },
    };
  }
  (paths[path] ??= {})[method] = operation;
}
const document = {
  openapi: "3.1.0",
  info: {
    title: "MCP FlowHub management API",
    version: JSON.parse(await readFile("package.json","utf8")).version,
    description:
      "Generated from actual registered route declarations and required/optional body fields. Dynamic fields are additionally constrained by runtime schemas and domain rules: consult contracts/source for field types and conditional validation. MCP /mcp uses the official SDK and is separate from this administrator API.",
  },
  servers: [{ url: "/" }],
  paths,
  components: {
    securitySchemes: {
      adminSession: { type: "apiKey", in: "cookie", name: "flowhub_session" },
    },
    schemas: {
      ApiResponse: {
        type: "object",
        properties: { data: {}, requestId: { type: "string" } },
        required: ["data", "requestId"],
      },
      ApiError: {
        type: "object",
        properties: {
          error: {
            type: "object",
            properties: {
              code: { type: "string" },
              message: { type: "string" },
            },
            required: ["code", "message"],
          },
          requestId: { type: "string" },
        },
        required: ["error", "requestId"],
      },
    },
  },
};
await mkdir("docs/generated", { recursive: true });
await writeFile(
  "docs/generated/openapi.json",
  JSON.stringify(document, null, 2) + "\n",
);
console.log(
  "Generated OpenAPI: " + Object.keys(paths).length + " management paths.",
);
