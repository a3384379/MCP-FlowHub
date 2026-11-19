import Fastify from "fastify";
import {
  createMcpHandler,
  type McpServer,
  type AuthInfo,
} from "@modelcontextprotocol/server";
import {
  toNodeHandler,
  type NodeIncomingMessageLike,
} from "@modelcontextprotocol/node";
import { tokenMatches } from "./local-config.js";

export const WEB_POLICY = "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";

/** Official SDK owns ALL modern and legacy wire adaptation. */
export function createLocalHttp(
  factory: (subject: string, codexSidebar: boolean) => McpServer,
  token: string,
  authorize?: (header: string | undefined) => string | undefined,
) {
  const app = Fastify({
    logger: false,
    bodyLimit: 1048576,
    requestTimeout: 15000,
  });
  const handler = createMcpHandler(
    (context) => {
      const subject = context.authInfo?.clientId;
      if (!subject) throw new Error("MCP authentication context is required.");
      return factory(subject, context.authInfo?.scopes.includes("flowhub:codex-sidebar") === true);
    },
    { legacy: "stateless", maxRequestBodySize: 262144 },
  );
  const nodeHandler = toNodeHandler(handler);
  app.addHook("onRequest", async (request, reply) => {
    const port = (app.server.address() as { port?: number } | null)?.port;
    if (
      request.headers.host !== `127.0.0.1:${port}` ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== `http://127.0.0.1:${port}`)
    ) {
      return reply.code(403).send({
        error: {
          code: "ORIGIN_DENIED",
          message: "Only the exact local origin and host are accepted.",
        },
      });
    }
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Cache-Control", "no-store");
    reply.header(
      "Content-Security-Policy",
      WEB_POLICY,
    );
  });
  app.route({
    method: ["GET", "POST", "DELETE"],
    url: "/mcp",
    // Bind authentication to the matched route, including encoded/absolute URLs.
    onRequest: async (request, reply) => {
      const personal = tokenMatches(request.headers.authorization, token);
      const subject = personal
        ? "execution"
        : authorize?.(request.headers.authorization);
      if (!subject)
        return reply.code(401).send({
          error: {
            code: "AUTH_REQUIRED",
            message: "A local execution token is required.",
          },
        });
      (request.raw as typeof request.raw & { auth: AuthInfo }).auth = {
        token: "[validated]",
        clientId: subject,
        scopes: personal && request.headers["x-flowhub-codex-sidebar"] === "1"
          ? ["workflow:execute", "flowhub:codex-sidebar"]
          : ["workflow:execute"],
      };
    },
    handler: async (request, reply) => {
      // The Node SDK adapter expects origin-form, while Fastify also accepts
      // absolute-form targets. Forward the matched endpoint with its query.
      const target = new URL(request.url, `http://${request.headers.host}`);
      request.raw.url = "/mcp" + target.search;
      reply.hijack();
      // Fastify guarantees method/url; the SDK structurally types these as nonoptional.
      await nodeHandler(
        request.raw as NodeIncomingMessageLike,
        reply.raw,
        request.body,
      );
    },
  });
  // Close official SDK subscriptions before Fastify waits for hijacked streams.
  app.addHook("preClose", async () => {
    await handler.close();
  });
  return app;
}
