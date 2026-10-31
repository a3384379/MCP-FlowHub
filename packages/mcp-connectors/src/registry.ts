import { isAbsolute, resolve } from "node:path";
import { adaptMcpResult, MCP_RAW_RESULT } from "./results.js";
import {
  Client,
  StreamableHTTPClientTransport,
  SdkHttpError,
  type Transport,
  type Tool,
} from "@modelcontextprotocol/client";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/client/validators/ajv";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/client/stdio";
import {
  MODERN_PROTOCOL,
  SDK_VERSION,
  VERSION,
  projectRoot,
} from "../../contracts/src/index.js";
import {
  ensure,
  hash,
  now,
  HubError,
  validate,
  type Json,
} from "../../contracts/src/domain.js";
import type { Repository } from "../../persistence/src/repository.js";
import type { Vault } from "../../security/src/index.js";
import {
  assertSafeSchemaPatterns,
  walkSchema,
} from "../../contracts/src/schema-safety.js";
class RestrictedToolValidator extends AjvJsonSchemaValidator {
  override getValidator<T>(schema: Json) {
    rejectRefs(schema);
    return super.getValidator<T>(schema);
  }
}
export class Connectors {
  private discoveryDisposals=new Map<AbortController,Promise<void>>();
  async closeDiscovery(){for(const controller of this.discoveryDisposals.keys())controller.abort();await Promise.allSettled(this.discoveryDisposals.values());}
  constructor(
    private repo: Repository,
    private vault: Vault,
  ) {
    // Older releases stored raw tools/list and discovery metadata. Their
    // contents cannot be screened while the vault is locked after restart.
    // Remove that cache before any API or workflow can consume it.
    this.repo.tx(() => {
      for (const c of this.repo.all("connections"))
        if (
          c.catalogSafetyVersion !== 1 &&
          (c.tools?.length || c.discovery || c.verifiedAt)
        ) {
          this.repo.put(
            "connections",
            c.id,
            {
              ...this.catalogView(c),
              revision: c.revision + 1,
            },
            c.revision,
          );
          this.invalidateBindings(c.id);
        }
    });
  }
  catalogView(c: Json): Json {
    if (c.catalogSafetyVersion === 1) return c;
    const {
      discovery,
      verifiedAt,
      verifiedSdk,
      verifiedRevision,
      history,
      ...safe
    } = c;
    return { ...safe, tools: [] };
  }
  private invalidateBindings(connectionId: string) {
    for (const b of this.repo.all("bindings"))
      if (b.connectionId === connectionId)
        this.repo.put(
          "bindings",
          b.id,
          {
            ...b,
            revision: b.revision + 1,
            validationStatus:
              b.revoked || b.validationStatus === "REVOKED"
                ? "REVOKED"
                : "UNVERIFIED",
            verification: null,
          },
          b.revision,
        );
  }
  transport(c: Json): Transport {
    if (c.synthetic)
      return new StdioClientTransport({
        command: process.execPath,
        args: [
          resolve(projectRoot, "dist/apps/daemon/src/cli.js"),
          "mock",
          "--stdio",
        ],
        env: getDefaultEnvironment(),
        stderr: "pipe",
        maxBufferSize: 1048576,
      });
    if (c.transport === "stdio") {
      ensure(
        c.commandApproved === true &&
          isAbsolute(c.command) &&
          !/\.(cmd|bat)$/i.test(c.command) &&
          !/(^|[/\\])(sh|bash|cmd|powershell|pwsh)(\.exe)?$/i.test(c.command),
        "COMMAND_DENIED",
        "An approved absolute executable is required.",
      );
      const env = getDefaultEnvironment();
      for (const [name, ref] of Object.entries(c.envRefs ?? {})) {
        ensure(
          /^[A-Z_][A-Z0-9_]*$/.test(name) &&
            !/^(NODE_|LD_|DYLD_|PATH$|HOME$|SHELL$|COMSPEC$|PYTHON)/i.test(
              name,
            ),
          "ENVIRONMENT_OVERRIDE_DENIED",
          "Unsafe process environment key.",
        );
        env[name] = this.vault.secret(String(ref));
      }
      return new StdioClientTransport({
        command: c.command,
        args: c.args,
        env,
        stderr: "pipe",
        maxBufferSize: 1048576,
      });
    }
    const url = new URL(c.endpoint);
    ensure(
      !url.username &&
        !url.password &&
        !url.hash &&
        c.allowedHosts.includes(url.hostname),
      "TARGET_DENIED",
      "Endpoint must match exact approved hosts.",
    );
    ensure(
      url.protocol === "https:" ||
        (url.protocol === "http:" && url.hostname === "127.0.0.1"),
      "TARGET_DENIED",
      "Only HTTPS or explicit loopback HTTP is allowed.",
    );
    return new StreamableHTTPClientTransport(url, {
      requestInit: {
        headers: c.secretRef
          ? { Authorization: "Bearer " + this.vault.secret(c.secretRef) }
          : {},
        redirect: "error",
      },
    });
  }
  async connect(
    c: Json,
    probe = false,
    timeout = 5000,
    beforeToolDispatch?: () => void,
    signal?: AbortSignal,
  ) {
    ensure(!c.disabled, "BINDING_REVOKED", "Connection disabled.");
    if (!probe)
      ensure(
        c.verifiedSdk === SDK_VERSION &&
          c.verifiedRevision === c.revision &&
          Date.parse(c.verifiedAt) + 86400000 > Date.now(),
        "PROTOCOL_REVERIFY_REQUIRED",
        "Connection validation expired or changed.",
      );
    const mode =
      probe && c.protocolEra === "auto"
        ? "auto"
        : c.protocolEra === "legacy"
          ? "legacy"
          : { pin: MODERN_PROTOCOL };
    const client = new Client(
      { name: "flowhub-connector", version: VERSION },
      {
        jsonSchemaValidator: new RestrictedToolValidator(),
        ...(probe?{listMaxPages:16}:{}),
        versionNegotiation: {
          mode,
          probe: { timeoutMs: Math.min(5000, timeout), maxRetries: 0 },
        },
      },
    );
    client.onerror = () => {
      void client.close();
    };
    try {
      const transport = this.transport(c);
      if (beforeToolDispatch) {
        const send = transport.send.bind(transport);
        transport.send = (message, options) => {
          if ("method" in message && message.method === "tools/call")
            beforeToolDispatch();
          return send(message, options);
        };
      }
      if (transport instanceof StdioClientTransport)
        transport.stderr?.on("data", () => {});
      await client.connect(transport, {
        timeout,
        ...(signal ? { signal } : {}),
        ...(!probe && c.discovery ? { prior: c.discovery } : {}),
      });
      return client;
    } catch (e) {
      await client.close();
      if (e instanceof HubError) throw e;
      if (e instanceof SdkHttpError && [401, 403].includes(e.status))
        throw new HubError(
          "AUTH_REQUIRED",
          "Downstream authentication or authorization denied; no fallback attempted.",
          401,
          { dispatched: false },
        );
      throw new HubError(
        "CONNECTION_FAILED",
        "MCP connection failed; check endpoint, permissions and protocol. No auth downgrade was attempted.",
        502,
        { dispatched: false },
      );
    }
  }
  async sync(connectionId: string) {
    const c = this.repo.get("connections", connectionId);
    ensure(c, "NOT_FOUND", "Connection missing.", 404);
    const context = this.vault.catalogContext();
    const next = await this.discover(c);
    this.vault.assertCatalogSafe(
      { tools: next.tools, discovery: next.discovery, history: next.history },
      context,
    );
    const schemaSet = (tools: Json[]) =>
      tools
        .map((t) => ({ name: t.name, schemaHash: t.schemaHash }))
        .sort((a, b) => a.name.localeCompare(b.name));
    const changed =
      c.catalogSafetyVersion === 1 &&
      hash(schemaSet(c.tools ?? [])) !== hash(schemaSet(next.tools));
    if (changed) {
      next.revision = c.revision + 1;
      next.verifiedRevision = next.revision;
    }
    this.repo.tx(() => {
      this.repo.put("connections", c.id, next, c.revision);
      if (changed) this.invalidateBindings(c.id);
    });
    return next;
  }
  // Discovery performs no persistence, so callers can commit related records
  // together after the external MCP exchange has completed.
  async discover(c: Json, control: { signal?: AbortSignal; deadline?: number; timeoutMs?: number } = {}) {
    const deadline = Math.min(control.deadline ?? Infinity, Date.now() + (control.timeoutMs ?? 10000));
    const controller = new AbortController();
    let disposed!:()=>void;
    this.discoveryDisposals.set(controller,new Promise<void>(resolve=>disposed=resolve));
    const abort = () => controller.abort(control.signal?.reason);
    if (control.signal?.aborted) abort(); else control.signal?.addEventListener("abort", abort, { once: true });
    const remaining = () => {
      ensure(!controller.signal.aborted && Date.now() < deadline, "DISCOVERY_CANCELLED", "Catalog discovery cancelled or timed out.");
      return Math.max(1, deadline - Date.now());
    };
    const timer = setTimeout(() => controller.abort(), Math.max(1, deadline - Date.now()));
    let context:ReturnType<Vault["catalogContext"]>;
    let client: Awaited<ReturnType<Connectors["connect"]>> | undefined;
    let next: Json;
    try {
      context = this.vault.catalogContext();
      client = await this.connect(c, true, remaining(), undefined, controller.signal);
      const tools: Json[] = [],
        cursors = new Set<string>();
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, { timeout: remaining(), signal: controller.signal, cacheMode: "bypass" });
        this.vault.assertCatalogSafe(page, context);
        for (const t of page.tools) {
          ensure(
            !tools.some((v) => v.name === t.name),
            "CATALOG_INVALID",
            "Duplicate tool in catalog.",
          );
          ensure(
            Buffer.byteLength(JSON.stringify(t)) <= 131072,
            "SCHEMA_LIMIT",
            "Tool schema too large.",
          );
          rejectRefs(t.inputSchema);
          if (t.outputSchema) rejectRefs(t.outputSchema);
          tools.push({
            ...t,
            schemaHash:
              "sha256:" +
              hash({
                inputSchema: t.inputSchema,
                outputSchema: t.outputSchema ?? null,
              }),
          });
        }
        cursor = page.nextCursor;
        if (cursor) {
          ensure(
            !cursors.has(cursor),
            "CATALOG_INVALID",
            "Repeated pagination cursor.",
          );
          cursors.add(cursor);
        }
        ensure(
          tools.length <= 1000 && cursors.size <= 100,
          "CATALOG_LIMIT",
          "Too many tools/pages.",
        );
      } while (cursor);
      const discovery = client.getDiscoverResult();
      next = {
        ...c,
        tools,
        protocolEra: client.getProtocolEra(),
        verifiedAt: now(),
        verifiedRevision: c.revision,
        verifiedSdk: SDK_VERSION,
        catalogSafetyVersion: 1,
        discovery: discovery
          ? { kind: "modern", discover: discovery, serverInfo: client.getServerVersion() }
          : { kind: "legacy", serverInfo: client.getServerVersion() },
        history: [
          ...(c.history ?? [])
            .slice(-9)
            .map((entry: Json) => ({ at: entry.at, hash: entry.hash })),
          { at: now(), hash: hash(tools) },
        ],
      };
    } finally {
      clearTimeout(timer);
      control.signal?.removeEventListener("abort", abort);
      try {await client?.close();} finally {this.discoveryDisposals.delete(controller);disposed();}
    }
    this.vault.assertCatalogSafe(
      { tools: next.tools, discovery: next.discovery, history: next.history },
      context,
    );
    return next;
  }
  async call(
    binding: Json,
    node: Json,
    args: Json,
    timeout: number,
    beforeDispatch?: () => void,
  ) {
    const deadline = Date.now() + timeout;
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      ensure(
        milliseconds > 0,
        "BUDGET_EXCEEDED",
        "Tool preparation and execution budget expired.",
      );
      return milliseconds;
    };
    const checkBinding = () => {
      const current = this.repo.get("bindings", binding.id),
        c = this.repo.get("connections", binding.connectionId);
      ensure(
        current &&
          current.validationStatus !== "REVOKED" &&
          current.revision === binding.revision &&
          c &&
          !c.disabled &&
          c.revision === binding.connectionRevision,
        "BINDING_REVOKED",
        "Binding changed or revoked.",
      );
      return c;
    };
    const c = checkBinding();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    let client: Client | undefined;
    let dispatched = false;
    try {
      client = await this.connect(
        c,
        false,
        Math.min(5000, remaining()),
        () => {
          remaining();
          checkBinding();
          beforeDispatch?.();
          dispatched = true;
        },
        controller.signal,
      );
      let live: Tool | undefined, cursor: string | undefined;
      const cursors = new Set<string>();
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined, {
          timeout: remaining(),
          signal: controller.signal,
        });
        live = page.tools.find((t) => t.name === node.config.toolName);
        cursor = page.nextCursor;
        if (cursor) {
          ensure(
            !cursors.has(cursor) && cursors.size < 100,
            "CATALOG_INVALID",
            "Invalid tool pagination.",
          );
          cursors.add(cursor);
        }
      } while (!live && cursor);
      ensure(
        live &&
          "sha256:" +
            hash({
              inputSchema: live.inputSchema,
              outputSchema: live.outputSchema ?? null,
            }) ===
            node.config.toolSchemaHash,
        "TOOL_SCHEMA_DRIFT",
        "Downstream schema differs from published snapshot.",
      );
      rejectRefs(live.inputSchema);
      if (live.outputSchema) rejectRefs(live.outputSchema);
      validate(live.inputSchema, args);
      const callTimeout = remaining();
      const value = await client.callTool(
        { name: live.name, arguments: args },
        {
          timeout: callTimeout,
          signal: controller.signal,
          toolDefinition: live,
        },
      );
      ensure(
        !value.isError,
        "TOOL_FAILED",
        "Downstream tool returned an error.",
      );
      const {value:out}=adaptMcpResult(value,node.config.resultAdapterRef??"structured",live.outputSchema);
      ensure(
        out.environment === undefined || out.environment === binding.environment,
        "ENVIRONMENT_MISMATCH",
        "Downstream environment evidence differs from binding.",
      );
      if (binding.simulationOnly)
        ensure(
          out.synthetic === true,
          "ENVIRONMENT_MISMATCH",
          "Synthetic binding returned non-synthetic data.",
        );
      if (Array.isArray(out.rows))
        ensure(
          out.rowCount === out.rows.length,
          "OUTPUT_INVALID",
          "Row count does not match actual rows.",
        );
      if(node.config.resultAdapterRef||node.config.capabilityRef)Object.defineProperty(out,MCP_RAW_RESULT,{value,enumerable:false});
      return out;
    } catch (error) {
      if (!dispatched && Date.now() >= deadline)
        throw new HubError(
          "BUDGET_EXCEEDED",
          "Tool preparation budget expired before dispatch.",
          422,
          { dispatched: false },
        );
      if (error instanceof SdkHttpError && [401, 403].includes(error.status))
        throw new HubError(
          "AUTH_REQUIRED",
          "Downstream authentication denied; no downgrade attempted.",
          401,
          { dispatched: false },
        );
      if (error instanceof HubError && !dispatched)
        error.details = { dispatched: false };
      throw error;
    } finally {
      clearTimeout(timer);
      await client?.close();
    }
  }
}
function rejectRefs(schema: Json) {
  walkSchema(schema, (node) => {
    if (typeof node === "boolean") return;
    ensure(
      !Object.hasOwn(node, "$dynamicRef") &&
        !Object.hasOwn(node, "$recursiveRef") &&
        (!Object.hasOwn(node, "$ref") ||
          (typeof node.$ref === "string" && node.$ref.startsWith("#/"))),
      "SCHEMA_INVALID",
      "Only bounded local schema references are allowed.",
    );
  });
  assertSafeSchemaPatterns(schema);
}
