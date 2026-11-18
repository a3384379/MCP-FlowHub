import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { openStore } from "../../../packages/persistence/src/index.js";
import { MIGRATIONS, validateMigrations } from "../../../packages/persistence/src/migrations.js";
import { Repository } from "../../../packages/persistence/src/repository.js";
import { Vault } from "../../../packages/security/src/index.js";
import { Connectors } from "../../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../../packages/workflow-core/src/engine.js";
import { registerAdmin } from "../../../packages/admin-api/src/index.js";
import { CodexLaunches } from "../../../packages/admin-api/src/codex-launch.js";
import { createHubServer } from "../../../packages/mcp-server/src/index.js";
import { renderSidebarResource, sidebarOpened, SIDEBAR_TOOL } from "../../../packages/mcp-server/src/codex-sidebar.js";
import { Application } from "../../../packages/application/src/index.js";
import type { ProviderFactory } from "../../../packages/llm-providers/src/index.js";
import {
  VERSION,
  RELEASE_PHASE,
  projectRoot,
  result,
  failure,
  TOOL_NAMES,
  EXECUTION_TOOL_NAMES,
} from "../../../packages/contracts/src/index.js";
import { HubError, hash } from "../../../packages/contracts/src/domain.js";
import {
  acquireLock,
  prepareDataDir,
  loadOrCreateToken,
} from "./local-config.js";
import { createLocalHttp, WEB_POLICY } from "./http.js";
export async function startDaemon(options: { dataDir: string; port: number; providerFactory?:ProviderFactory;hostDiscoveryRuntime?:import("../../../packages/host-discovery/src/index.js").DiscoveryRuntime }) {
  const dataDir = await prepareDataDir(options.dataDir),
    unlock = await acquireLock(dataDir);
  let store: ReturnType<typeof openStore> | undefined,
    app: ReturnType<typeof createLocalHttp> | undefined,
    engine: Engine | undefined,
    application: Application | undefined;
  let endpointWritten = false;
  let stopping = false;
  let resourcesClosed: Promise<void> | undefined;
  const closeResources = () => resourcesClosed ??= (async () => {
    // All workers must finish their final durable state transitions while the
    // database and Vault are still available, including partial startup failure.
    let failure:unknown;
    try { await application?.close(); } catch(error) { failure=error; }
    try { await engine?.close(); } catch(error) { failure??=error; }
    // A failing preClose hook can prevent Fastify's onClose hooks from running.
    // Erase the in-memory key here as well, after all durable workers settle.
    engine?.vault.lock();
    if(failure)throw failure;
  })();
  const closeHttp = async () => {
    try { await app?.close(); }
    catch(error) {
      // Fastify can stop before closing its listener when a preClose hook
      // rejects. The stopping gate is already active; also release the sockets.
      if(app?.server.listening)await new Promise<void>(resolve=>{
        app!.server.close(()=>resolve());app!.server.closeAllConnections();
      });
      throw error;
    }
  };
  try {
    const token = await loadOrCreateToken(dataDir);
    store = openStore(join(dataDir, "flowhub.sqlite"));
    const applied=validateMigrations(store.db,true);
    if(applied>0 && applied<MIGRATIONS.length) {
      const { backupDirectory } = await import("../../../packages/admin-api/src/local-backups.js");
      await store.db.backup(join(await backupDirectory(dataDir,true), "pre-v2-"+Date.now()+".sqlite"));
    }
    const instanceId = store.instanceId,
      repo = new Repository(store.db),
      vault = new Vault(repo);
    engine = new Engine(repo, vault, new Connectors(repo, vault));
    await engine.seed();
    if (repo.all("runs").some(r => !["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED", "OUTCOME_UNKNOWN"].includes(r.state) &&
      (r.state === "WAITING_APPROVAL" || r.snapshot?.workflow?.nodes?.some((n: { type: string }) => n.type === "approval")))) {
      const { backupDirectory } = await import("../../../packages/admin-api/src/local-backups.js");
      await repo.backup(join(await backupDirectory(dataDir, true), "pre-legacy-retirement-" + instanceId + ".sqlite"));
    }
    engine.recover();
    application=new Application(engine,{...(options.providerFactory?{providerFactory:options.providerFactory}:{}),...(options.hostDiscoveryRuntime?{hostDiscoveryRuntime:options.hostDiscoveryRuntime}:{})});
    const service=application;
    const launches = new CodexLaunches();
    const localOrigin = () => `http://127.0.0.1:${(app!.server.address() as { port: number }).port}`;
    app = createLocalHttp(
      (subject, codexSidebar) =>
        createHubServer(async (name, args) => {
          try {
            if(stopping)throw new HubError("SERVICE_STOPPING","FlowHub is stopping.",503);
            if (codexSidebar && name === SIDEBAR_TOOL && Object.keys(args).length === 0)
              return sidebarOpened(launches.issue());
            return result({
              ...await service.handle(name, args, subject),
              instanceId,
            });
          } catch (error) {
            const e =
              error instanceof HubError
                ? error
                : new HubError(
                    "INTERNAL_ERROR",
                    "Operation could not be completed.",
                  );
            return failure(e.code, e.message, e.details);
          }
        }, subject==="execution"||repo.get("clients",subject)?.scopes?.includes("workflow:author")?TOOL_NAMES:EXECUTION_TOOL_NAMES,
        codexSidebar ? { readSidebar: () => renderSidebarResource(localOrigin()) } : {}),
      token,
      (header) => {
        if (!header?.startsWith("Bearer ")) return undefined;
        return repo
          .all("clients")
          .find((c) => !c.revoked && c.tokenHash === hash(header.slice(7)))?.id;
      },
    );
    app.addHook("onRequest",async (_request,reply)=>{
      if(stopping)return reply.code(503).send({error:{code:"SERVICE_STOPPING",message:"FlowHub is stopping."}});
    });
    // Fastify invokes this before its onClose hook locks the Vault. Setting the
    // gate synchronously in close() prevents new work during worker shutdown.
    app.addHook("preClose",async()=>{stopping=true;await closeResources();});
    await registerAdmin(app, engine, dataDir, service.authoring, service.registry, service, launches);
    app.get("/api/v1/health", async () => ({
      status: "ok",
      version: VERSION,
      phase: RELEASE_PHASE,
      syntheticOnly: false,
    }));
    const webRoot = resolve(projectRoot, "web-dist"),
      files = new Map<string, { body: Buffer; type: string }>();
    try {
      const index = await readFile(join(webRoot, "index.html"));
      files.set("/", { body: index, type: "text/html; charset=utf-8" });
      for (const name of await readdir(join(webRoot, "assets"))) {
        if (!/^[\w.-]+$/.test(name)) continue;
        files.set("/assets/" + name, {
          body: await readFile(join(webRoot, "assets", name)),
          type: name.endsWith(".js")
            ? "text/javascript"
            : name.endsWith(".css")
              ? "text/css"
              : "application/octet-stream",
        });
      }
    } catch {
      files.set("/", {
        body: Buffer.from(
          '<!doctype html><meta charset="utf-8"><title>FlowHub</title><p>FlowHub daemon running. Run npm run build to compile the management UI.</p>',
        ),
        type: "text/html; charset=utf-8",
      });
    }
    app.get("/", async (_req, reply) =>
      reply.type(files.get("/")!.type).send(files.get("/")!.body),
    );
    const workspace = files.get("/")!;
    const codexPage = workspace.body.toString("utf8").replace(
      "</head>", '<meta name="flowhub-codex-sidebar" content="1"></head>',
    );
    const codexPolicy = WEB_POLICY.replace(
      "frame-ancestors 'none'",
      "frame-ancestors codex-sandbox://web-sandbox.oaiusercontent.com codex-sandbox://*.web-sandbox.oaiusercontent.com https://web-sandbox.oaiusercontent.com https://*.web-sandbox.oaiusercontent.com",
    );
    app.get("/codex/*", async (_req, reply) =>
      reply.header("Content-Security-Policy", codexPolicy)
        .header("Referrer-Policy", "no-referrer")
        .type(workspace.type)
        .send(codexPage),
    );
    app.get("/*", async (req, reply) => {
      const path = req.url.split("?")[0]!;
      if (path.startsWith("/api/") || path === "/mcp")
        return reply
          .code(404)
          .send({ error: { code: "NOT_FOUND", message: "Unknown endpoint." } });
      const file =
        files.get(path) ??
        (!path.startsWith("/assets/") ? files.get("/") : undefined);
      if (!file) return reply.code(404).send({ error: { code: "NOT_FOUND" } });
      return reply.type(file.type).send(file.body);
    });
    await app.listen({ host: "127.0.0.1", port: options.port });
    const port = (app.server.address() as { port: number }).port;
    service.registry.setSelfIdentity({endpoints:[`http://127.0.0.1:${port}/mcp`],instanceId});
    await writeFile(
      join(dataDir, "endpoint.json"),
      JSON.stringify({ port, pid: process.pid, instanceId }),
      { mode: 0o600 },
    );
    endpointWritten = true;
    let closePromise: Promise<void>|undefined;
    return {
      port,
      instanceId,
      boots: store.boots,
      engine,
      application:service,
      close: () => {
        if(closePromise)return closePromise;
        stopping = true;
        closePromise=(async()=>{
          try {
            await closeHttp();
          } finally {
            try {
              await closeResources();
            } finally {
              try { await unlink(join(dataDir, "endpoint.json")); }
              finally { try { store!.close(); } finally { await unlock(); } }
            }
          }
        })();
        return closePromise;
      },
    };
  } catch (error) {
    stopping=true;
    // A listener/configuration failure must close the Application too. Preserve
    // the startup error while attempting every cleanup, even if one hook fails.
    await closeHttp().catch(()=>{});
    await closeResources().catch(()=>{});
    try { if (endpointWritten) await unlink(join(dataDir, "endpoint.json")); }
    finally { try { store?.close(); } finally { await unlock(); } }
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new Error(
        "PORT_IN_USE: choose a free --port. No other process was stopped.",
      );
    throw error;
  }
}
