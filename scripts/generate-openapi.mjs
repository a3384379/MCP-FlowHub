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
    (route === "/api/v1/auth/session" && method === "post");
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
  if (code.includes("revision(req)"))
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
  if (route.endsWith("/events"))
    operation.responses[200] = {
      description: "Authenticated event stream; Last-Event-ID or after cursor",
      content: { "text/event-stream": { schema: { type: "string" } } },
    };
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
