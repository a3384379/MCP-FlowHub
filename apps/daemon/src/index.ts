import { readFile, writeFile, unlink, readdir } from "node:fs/promises";
import { join, resolve, extname } from "node:path";
import { openStore } from "../../../packages/persistence/src/index.js";
import { MIGRATIONS, validateMigrations } from "../../../packages/persistence/src/migrations.js";
import { Repository } from "../../../packages/persistence/src/repository.js";
import { Vault } from "../../../packages/security/src/index.js";
import { Connectors } from "../../../packages/mcp-connectors/src/registry.js";
import { Engine } from "../../../packages/workflow-core/src/engine.js";
import { registerAdmin } from "../../../packages/admin-api/src/index.js";
import { createHubServer } from "../../../packages/mcp-server/src/index.js";
import { Application } from "../../../packages/application/src/index.js";
import {
  VERSION,
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
import { createLocalHttp } from "./http.js";
export async function startDaemon(options: { dataDir: string; port: number }) {
  const dataDir = await prepareDataDir(options.dataDir),
    unlock = await acquireLock(dataDir);
  let store: ReturnType<typeof openStore> | undefined,
    app: ReturnType<typeof createLocalHttp> | undefined,
    engine: Engine | undefined;
  let endpointWritten = false;
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
    const service = engine, application=new Application(engine);
    app = createLocalHttp(
      (subject) =>
        createHubServer(async (name, args) => {
          try {
            return result({
              ...await application.handle(name, args, subject),
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
        }, subject==="execution"||repo.get("clients",subject)?.scopes?.includes("workflow:author")?TOOL_NAMES:EXECUTION_TOOL_NAMES),
      token,
      (header) => {
        if (!header?.startsWith("Bearer ")) return undefined;
        return repo
          .all("clients")
          .find((c) => !c.revoked && c.tokenHash === hash(header.slice(7)))?.id;
      },
    );
    await registerAdmin(app, engine, dataDir, application.authoring, application.registry, application);
    app.get("/api/v1/health", async () => ({
      status: "ok",
      version: VERSION,
      phase: "RC",
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
    await writeFile(
      join(dataDir, "endpoint.json"),
      JSON.stringify({ port, pid: process.pid, instanceId }),
      { mode: 0o600 },
    );
    endpointWritten = true;
    let closed = false;
    return {
      port,
      instanceId,
      boots: store.boots,
      engine,
      application,
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await application.close();
          await service.close();
          await app!.close();
        } finally {
          try {
            await unlink(join(dataDir, "endpoint.json"));
          } finally {
            store!.close();
            await unlock();
          }
        }
      },
    };
  } catch (error) {
    await engine?.close();
    await app?.close();
    if (endpointWritten) await unlink(join(dataDir, "endpoint.json"));
    store?.close();
    await unlock();
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE")
      throw new Error(
        "PORT_IN_USE: choose a free --port. No other process was stopped.",
      );
    throw error;
  }
}
