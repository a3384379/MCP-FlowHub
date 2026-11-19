import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  readFile,
  writeFile,
  unlink,
  mkdir,
  lstat,
  realpath,
  stat,
} from "node:fs/promises";
import { join } from "node:path";
import { randomBytes, timingSafeEqual } from "node:crypto";
import {
  ensure,
  HubError,
  now,
  id,
  hash,
  get,
  validate,
  clone,
  type Json,
  type Workflow,
} from "../../contracts/src/domain.js";
import { withoutLegacyNodes } from "../../workflow-core/src/legacy-migration.js";
import { validateWorkflowDocument } from "../../workflow-core/src/validate.js";
import { workflowRequirements } from "../../contracts/src/workflow-requirements.js";
import { VERSION, TOOL_NAMES, projectRoot } from "../../contracts/src/index.js";
import type { Engine } from "../../workflow-core/src/engine.js";
import { AdminAuth, DEFAULT_ADMIN_USERNAME, DEFAULT_ADMIN_PASSWORD } from "../../security/src/index.js";
import { AuthoringService } from "../../workflow-authoring/src/index.js";
import { CapabilityRegistry } from "../../capability-registry/src/index.js";
import { registerV2 } from "./v2.js";
import type { Application } from "../../application/src/index.js";
import {
  previewRetention,
  commitRetention,
} from "../../persistence/src/retention.js";
import { backupDirectory, localBackups, preflightLocalBackup } from "./local-backups.js";
import { hostIntegration, localCliPath, offlineRestoreInstructions } from "./settings-integration.js";
import { credentialInventory } from "../../security/src/credential-metadata.js";
import type { CodexLaunches } from "./codex-launch.js";
import {
  bindingImpact,
  eventCursor,
  eventPageQuery,
  runListView,
} from "./admin-views.js";

export async function registerAdmin(
  app: FastifyInstance,
  engine: Engine,
  dataDir: string,
  authoring = new AuthoringService(engine),
  registry = new CapabilityRegistry(engine),
  application?: Application,
  codexLaunches?: CodexLaunches,
) {
  const { repo, vault, connectors } = engine,
    auth = new AdminAuth(repo),
    setupPath = join(dataDir, "admin-setup-token");
  const eventStreams = new Map<() => void, string | undefined>();
  let streamsClosing = false;
  const closeInvalidEventStreams = () => {
    for (const [close, cookie] of eventStreams) {
      try {
        auth.check(cookie);
      } catch {
        close();
      }
    }
  };
  if (!auth.initialized) {
    try {
      await writeFile(setupPath, randomBytes(32).toString("hex"), {
        flag: "wx",
        mode: 0o600,
      });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  const body = (
    req: FastifyRequest,
    required: string[],
    optional: string[] = [],
  ): Json => {
    const value = req.body;
    ensure(
      value && typeof value === "object" && !Array.isArray(value),
      "INPUT_INVALID",
      "JSON object required.",
    );
    ensure(
      required.every((k) => Object.hasOwn(value, k)) &&
        Object.keys(value).every(
          (k) => required.includes(k) || optional.includes(k),
        ),
      "INPUT_INVALID",
      "Missing or unknown request fields.",
    );
    return value;
  };
  const revision = (req: FastifyRequest) => {
    const value = req.headers["if-match"];
    ensure(
      typeof value === "string" && /^\d+$/.test(value),
      "REVISION_REQUIRED",
      "If-Match revision required.",
      428,
    );
    return Number(value);
  };
  const param = (req: FastifyRequest, name = "id") =>
    String((req.params as Json)[name]);
  const data = (value: Json) => ({ data: value, requestId: id("req") });
  const listRuns = runListView(repo);
  app.get("/api/v1/openapi.json", async () =>
    JSON.parse(
      await readFile(join(projectRoot, "docs/generated/openapi.json"), "utf8"),
    ),
  );
  app.setErrorHandler((error, req, reply) => {
    const status = (error as { statusCode?: number }).statusCode;
    const e =
      error instanceof HubError
        ? error
        : new HubError(
            status === 413
              ? "BUDGET_EXCEEDED"
              : status === 400
                ? "INPUT_INVALID"
                : "INTERNAL_ERROR",
            "Request could not be completed.",
            status ?? 500,
          );
    reply.code(e.status).send({
      error: { code: e.code, message: e.message, details: e.details },
      requestId: id("req"),
    });
  });
  app.addHook("onRequest", async (req) => {
    // Use Fastify's matched route template; the raw URL may be absolute or encoded.
    const path = req.routeOptions.url;
    if (!path?.startsWith("/api/v1/") && !path?.startsWith("/api/v2/")) return;
    if (
      (["GET", "HEAD"].includes(req.method) &&
        ["/api/v1/health", "/api/v1/auth/state"].includes(path)) ||
      (req.method === "POST" &&
        ["/api/v1/auth/session", "/api/v1/auth/bootstrap", "/api/v1/auth/local-session", "/api/v1/auth/codex-session"].includes(path))
    )
      return;
    auth.check(
      req.headers.cookie,
      String(req.headers["x-csrf-token"] ?? ""),
      !["GET", "HEAD", "OPTIONS"].includes(req.method),
    );
  });
  const setSessionCookie = (reply: Json, session: Json, codex = false) => {
    closeInvalidEventStreams();
    reply.header(
      "Set-Cookie",
      codex
        ? `flowhub_codex_session=${session.token}; HttpOnly; SameSite=None; Secure; Partitioned; Path=/; Max-Age=28800`
        : `flowhub_session=${session.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800`,
    );
  };
  app.get("/api/v1/auth/state", async () =>
    data({
      initialized: auth.initialized,
      vaultInitialized: vault.initialized,
      vaultLocked: vault.locked,
      version: VERSION,
    }),
  );
  const requireLocalOrigin = (req: FastifyRequest) => {
    const address = app.server.address();
    ensure(
      address && typeof address === "object" && address.address === "127.0.0.1" &&
        req.ip === "127.0.0.1" &&
        req.headers.host === `127.0.0.1:${address.port}` &&
        req.headers.origin === `http://127.0.0.1:${address.port}` &&
        req.headers["x-flowhub-local"] === "1" &&
        (req.headers["sec-fetch-site"] === undefined || req.headers["sec-fetch-site"] === "same-origin"),
      "ORIGIN_DENIED",
      "A same-origin request from the local workspace is required.",
      403,
    );
  };
  app.post("/api/v1/auth/local-session", async (req, reply) => {
    requireLocalOrigin(req);
    body(req, []);
    try {
      return data({ csrf: auth.check(req.headers.cookie, undefined, false, false).csrf });
    } catch (error) {
      if (!(error instanceof HubError && error.code === "AUTH_REQUIRED")) throw error;
    }
    const session = auth.session();
    setSessionCookie(reply, session);
    return data({ csrf: session.csrf });
  });
  app.post("/api/v1/auth/codex-session", async (req, reply) => {
    requireLocalOrigin(req);
    const { ticket } = body(req, ["ticket"]);
    ensure(codexLaunches?.redeem(ticket), "AUTH_REQUIRED", "Reopen FlowHub from the Codex sidebar.", 401);
    const session = auth.session(true);
    setSessionCookie(reply, session, true);
    return data({ csrf: session.csrf });
  });
  app.post("/api/v1/auth/bootstrap", async (req, reply) => {
    auth.throttle("bootstrap");
    const b = body(req, ["setupToken", "password"]);
    ensure(
      !auth.initialized,
      "ADMIN_EXISTS",
      "Administrator already configured.",
      409,
    );
    const expected = (await readFile(setupPath, "utf8")).trim();
    ensure(
      typeof b.setupToken === "string" && hash(b.setupToken) === hash(expected),
      "AUTH_REQUIRED",
      "Invalid local setup token.",
      401,
    );
    repo.tx(() => {
      auth.setup(b.password);
      if (!vault.initialized) vault.initialize(b.password);
    });
    await unlink(setupPath);
    const session = auth.session();
    setSessionCookie(reply, session);
    return data({ csrf: session.csrf });
  });
  app.post("/api/v1/auth/session", async (req, reply) => {
    const b = body(req, ["password"], ["username"]);
    if (!auth.initialized) {
      auth.throttle("default-bootstrap");
      ensure((b.username === undefined || b.username === DEFAULT_ADMIN_USERNAME) &&
        b.password === DEFAULT_ADMIN_PASSWORD && !vault.initialized,
        "AUTH_REQUIRED", "Invalid administrator account or password.", 401);
      try {
        repo.tx(() => {
          auth.setup(DEFAULT_ADMIN_PASSWORD, true);
          vault.initialize(DEFAULT_ADMIN_PASSWORD, true);
        });
      } catch (error) { vault.lock(); throw error; }
      await unlink(setupPath).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    const session = auth.login(b.password, b.username);
    setSessionCookie(reply, session);
    return data({ csrf: session.csrf });
  });
  app.get("/api/v1/auth/session", async (req) =>
    data({ csrf: auth.check(req.headers.cookie).csrf }),
  );
  app.delete("/api/v1/auth/session", async (req, reply) => {
    auth.logout(req.headers.cookie);
    closeInvalidEventStreams();
    reply.header(
      "Set-Cookie",
      "flowhub_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
    );
    return data({ loggedOut: true });
  });
  app.post("/api/v1/vault/initialize", async (req) => {
    const b = body(req, ["password"]);
    ensure(!vault.initialized, "VAULT_EXISTS", "Vault already initialized.", 409);
    try {
      repo.tx(() => {
        vault.initialize(b.password);
        repo.audit("admin", "vault:initialize", "vault");
      });
    } catch (error) {
      vault.lock();
      throw error;
    }
    auth.resetThrottle("vault");
    return data({ initialized: true, locked: false });
  });
  app.post("/api/v1/vault/unlock", async (req) => {
    auth.throttle("vault");
    const b = body(req, ["password"]);
    vault.unlock(b.password);
    auth.resetThrottle("vault");
    return data({ locked: vault.locked });
  });
  app.post("/api/v1/vault/lock", async () => {
    vault.lock();
    return data({ locked: true });
  });
  app.post("/api/v1/vault/password", async (req) => {
    auth.throttle("vault");
    const b = body(req, ["oldPassword", "newPassword"]);
    vault.changePassword(b.oldPassword, b.newPassword);
    auth.resetThrottle("vault");
    repo.audit("admin", "vault:change-password", "vault");
    return data({ changed: true });
  });
  app.post("/api/v1/secrets", async (req) => {
    const b = body(req, ["label", "value"], ["purpose", "idempotencyKey"]);
    ensure(
      typeof b.label === "string" && b.label.trim().length > 0 && b.label.length <= 128,
      "INPUT_INVALID",
      "Invalid secret label.",
    );
    const save = () => vault.addSecret(b.label, b.value, { purpose: b.purpose });
    if (b.idempotencyKey !== undefined) ensure(typeof b.idempotencyKey === "string" && b.idempotencyKey.length > 0 && b.idempotencyKey.length <= 256, "INPUT_INVALID", "Invalid idempotency key.");
    return data(b.idempotencyKey ? repo.command("admin", "secret.create", b.idempotencyKey, b, save) : save());
  });
  app.get("/api/v1/secrets", async () =>
    data(credentialInventory(repo)),
  );
  app.get("/api/v1/settings", async () => {
    const address = app.server.address();
    return data({
      version: VERSION,
      vaultLocked: vault.locked,
      tools: TOOL_NAMES,
      runtimePath: process.execPath,
      cliPath: localCliPath,
      dataDir,
      databaseSizeBytes: (await stat(join(dataDir, "flowhub.sqlite"))).size,
      backupDirectory: join(dataDir, "backups"),
      mcpEndpoint: address && typeof address === "object"
        ? "http://127.0.0.1:" + address.port + "/mcp" : null,
      hostVerification: {
        status: "not_performed",
        message: "当前机器真实 Codex 接入尚未验证；Mock 或 UI 检查不能替代宿主验收。",
      },
      bindAddress: "127.0.0.1",
      dataSeparated: true,
      simulationOnly: false,
      verification:
        "Enterprise and Windows acceptance must be recorded separately.",
    });
  });
  const clientIntegration = (clientId: string) => hostIntegration({
    runtimePath: process.execPath,
    cliPath: localCliPath,
    dataDir,
    tokenFile: join(dataDir, "clients", clientId + ".token"),
  });
  app.get("/api/v1/clients", async () =>
    data(repo.all("clients").map(({ tokenHash, ...c }) => ({
      ...c,
      hostIntegration: c.revoked ? null : clientIntegration(c.id),
    }))),
  );
  app.post("/api/v1/clients", async (req) => {
    const b = body(req, ["label", "workflowAllowlist"], ["authoring"]);
    ensure(
      typeof b.label === "string" &&
        b.label.length > 0 &&
        b.label.length <= 128 &&
        Array.isArray(b.workflowAllowlist) &&
        (b.workflowAllowlist.length > 0 || b.authoring === true) &&
        b.workflowAllowlist.length <= 100 &&
        b.workflowAllowlist.every(
          (w: Json) => typeof w === "string" && repo.get("workflows", w) && !repo.get("workflows", w).deletedAt,
        ),
      "INPUT_INVALID",
      "Label and explicit workflow allowlist required.",
    );
    const token = randomBytes(32).toString("hex"),
      client = {
        id: id("client"),
        label: b.label,
        workflowAllowlist: b.workflowAllowlist,
        scopes: b.authoring === true ? ["workflow:execute", "workflow:author"] : ["workflow:execute"],
        tokenHash: hash(token),
        revoked: false,
        createdAt: now(),
        revision: 1,
      };
    const directory = join(dataDir, "clients");
    await mkdir(directory, { recursive: true, mode: 0o700 });
    ensure(
      (await lstat(directory)).isDirectory() &&
        (await realpath(directory)) === directory,
      "INPUT_INVALID",
      "The local client-token directory must be a regular directory, not a link.",
    );
    const filename = client.id + ".token";
    await writeFile(join(directory, filename), token, {
      mode: 0o600,
      flag: "wx",
    });
    repo.insert("clients", client.id, client);
    repo.audit("admin", "client:create", client.id);
    return data({
      id: client.id,
      label: client.label,
      tokenFile: "clients/" + filename,
      absoluteTokenFile: join(directory, filename),
      workflowAllowlist: client.workflowAllowlist,
      hostIntegration: clientIntegration(client.id),
    });
  });
  app.post("/api/v1/clients/:id/revoke", async (req) => {
    const c = repo.get("clients", param(req));
    ensure(c, "NOT_FOUND", "Client missing.", 404);
    repo.put("clients", c.id, {
      ...c,
      revoked: true,
      revision: c.revision + 1,
    });
    repo.audit("admin", "client:revoke", c.id);
    return data({ revoked: true });
  });

  app.get("/api/v1/connections", async () =>
    data(repo.all("connections").map((c) => connectors.catalogView(c))),
  );
  const assertMcpCredentialPurpose = (configuration: Json) => {
    const refs = [configuration.secretRef, ...Object.values(configuration.envRefs ?? {})];
    ensure(!credentialInventory(repo).some(item => item.modelCredential && refs.includes(item.id)), "CREDENTIAL_PURPOSE_MISMATCH", "模型专用 Key 不能用于 MCP 连接，请配置对应的连接凭据。", 409);
  };
  app.post("/api/v1/connections", async (req) => {
    const b = body(
      req,
      ["name", "transport", "protocolEra"],
      [
        "endpoint",
        "allowedHosts",
        "secretRef",
        "command",
        "args",
        "commandApproved",
        "envRefs",
      ],
    );
    validate(
      {
        type: "object",
        properties: {
          name: { type: "string", minLength: 1, maxLength: 128 },
          transport: { enum: ["stdio", "streamable_http"] },
          protocolEra: { enum: ["modern", "legacy", "auto"] },
          endpoint: { type: "string", maxLength: 2048 },
          allowedHosts: {
            type: "array",
            items: { type: "string" },
            minItems: 1,
            maxItems: 20,
          },
          secretRef: { type: "string" },
          command: { type: "string", maxLength: 2048 },
          args: {
            type: "array",
            maxItems: 64,
            items: { type: "string", maxLength: 4096 },
          },
          commandApproved: { const: true },
          envRefs: {
            type: "object",
            maxProperties: 20,
            additionalProperties: { type: "string" },
          },
        },
        required: ["name", "transport", "protocolEra"],
        additionalProperties: false,
      },
      b,
    );
    if (b.transport === "stdio")
      ensure(
        typeof b.command === "string" &&
          Array.isArray(b.args) &&
          b.commandApproved === true,
        "COMMAND_DENIED",
        "Explicit executable approval required.",
      );
    else
      ensure(
        typeof b.endpoint === "string" && Array.isArray(b.allowedHosts),
        "TARGET_DENIED",
        "Endpoint and approved hosts required.",
      );
    const c = {
      ...b,
      id: id("connection"),
      revision: 1,
      synthetic: false,
      disabled: false,
      tools: [],
      createdAt: now(),
    };
    assertMcpCredentialPurpose(c);
    repo.insert("connections", c.id, c);
    repo.audit("admin", "connection:create", c.id);
    return data(c);
  });
  app.patch("/api/v1/connections/:id", async (req) => {
    const c = repo.get("connections", param(req));
    ensure(
      c && !c.synthetic,
      "NOT_FOUND",
      "Real connection missing or synthetic configuration fixed.",
      404,
    );
    const b = body(
      req,
      [],
      [
        "name",
        "endpoint",
        "allowedHosts",
        "secretRef",
        "command",
        "args",
        "commandApproved",
        "envRefs",
        "protocolEra",
        "disabled",
      ],
    );
    const expected = revision(req);
    // A configuration change already invalidates the connection and bindings.
    // Its cleared catalog is not a verified baseline for detecting live drift.
    const {
      catalogSafetyVersion,
      discovery,
      history,
      verifiedRevision,
      ...configuration
    } = c;
    const next = {
      ...configuration,
      ...b,
      revision: expected + 1,
      verifiedAt: null,
      verifiedSdk: null,
      tools: [],
    };
    assertMcpCredentialPurpose(next);
    repo.put("connections", c.id, next, expected);
    for (const binding of repo
      .all("bindings")
      .filter((b) => b.connectionId === c.id))
      repo.put("bindings", binding.id, {
        ...binding,
        validationStatus: "UNVERIFIED",
        revision: binding.revision + 1,
      });
    repo.audit("admin", "connection:update", c.id);
    return data(next);
  });
  app.post("/api/v1/connections/:id/test", async (req) =>
    data(await connectors.sync(param(req))),
  );
  app.post("/api/v1/connections/:id/sync-tools", async (req) =>
    data(await connectors.sync(param(req))),
  );
  app.get("/api/v1/tools", async () =>
    data(
      repo
        .all("connections")
        .map((c) => connectors.catalogView(c))
        .flatMap((c) =>
          (c.tools ?? []).map((t: Json) => ({
            ...t,
            connectionId: c.id,
            connectionName: c.name,
            synthetic: c.synthetic,
            verifiedAt: c.verifiedAt,
          })),
        ),
    ),
  );

  app.get("/api/v1/bindings", async () => data(repo.all("bindings")));
  app.get("/api/v1/bindings/:id/impact", async (req) =>
    data(vault.protectDiagnostic(bindingImpact(repo, param(req)))),
  );
  app.post("/api/v1/bindings", async (req) => {
    const b = body(req, [
      "name",
      "connectionId",
      "environment",
      "allowedTools",
      "lockedArguments",
      "allowedQueryTemplates",
      "maxRows",
      "timeoutSeconds",
    ]);
    validate(bindingSchema, b);
    const c = repo.get("connections", b.connectionId);
    ensure(c, "NOT_FOUND", "Connection missing.", 404);
    const v = {
      ...b,
      id: id("binding"),
      revision: 1,
      connectionRevision: c.revision,
      simulationOnly: !!c.synthetic,
      validationStatus: "UNVERIFIED",
      createdAt: now(),
    };
    repo.insert("bindings", v.id, v);
    return data(v);
  });
  app.patch("/api/v1/bindings/:id", async (req) => {
    const old = repo.get("bindings", param(req));
    ensure(old, "NOT_FOUND", "Binding missing.", 404);
    const b = body(
      req,
      [],
      [
        "name",
        "allowedTools",
        "lockedArguments",
        "allowedQueryTemplates",
        "maxRows",
        "timeoutSeconds",
        "revoked",
      ],
    );
    const expected = revision(req),
      next = {
        ...old,
        ...b,
        revision: expected + 1,
        validationStatus: b.revoked ? "REVOKED" : "UNVERIFIED",
      };
    validate(
      bindingSchema,
      Object.fromEntries(
        Object.keys(bindingSchema.properties).map((k) => [k, next[k]]),
      ),
    );
    repo.put("bindings", old.id, next, expected);
    repo.audit("admin", "binding:update", old.id);
    return data(next);
  });
  app.post("/api/v1/bindings/:id/verify", async (req) => {
    const b = repo.get("bindings", param(req));
    ensure(b, "NOT_FOUND", "Binding missing.", 404);
    const deadline = Date.now() + Math.min(10000, b.timeoutSeconds * 1000);
    const signal = AbortSignal.timeout(
      Math.min(10000, b.timeoutSeconds * 1000),
    );
    const remaining = () => {
      const milliseconds = deadline - Date.now();
      ensure(
        milliseconds > 0,
        "BUDGET_EXCEEDED",
        "Binding verification preparation and probe deadline expired.",
        408,
      );
      return milliseconds;
    };
    const initialConnection = repo.get("connections", b.connectionId);
    const checkCurrentBinding = () => {
      remaining();
      const current = repo.get("bindings", b.id),
        connection = repo.get("connections", b.connectionId);
      ensure(
        current &&
          !current.revoked &&
          current.validationStatus !== "REVOKED" &&
          current.revision === b.revision &&
          initialConnection &&
          connection &&
          !connection.disabled &&
          connection.revision === initialConnection.revision,
        "BINDING_REVOKED",
        "Binding or connection changed or was revoked during verification.",
        409,
      );
    };
    checkCurrentBinding();
    const request = body(
      req,
      [
        "probe",
        "serverEnforcedReadOnly",
        "scope",
        "expectedEnvironmentPointer",
      ],
      ["expectedEnvironmentValue"],
    );
    ensure(
      request.serverEnforcedReadOnly === true &&
        typeof request.scope === "string" &&
        request.scope.length > 0,
      "BINDING_UNVERIFIED",
      "Independent server-side read-only attestation and approved scope are required.",
    );
    ensure(
      request.probe &&
        typeof request.probe.toolName === "string" &&
        typeof request.probe.arguments === "object" &&
        Object.keys(request.probe).every((k) =>
          ["toolName", "arguments"].includes(k),
        ),
      "INPUT_INVALID",
      "Explicit approved probe required.",
    );
    ensure(
      b.allowedTools.includes(request.probe.toolName),
      "TOOL_NOT_ALLOWED",
      "Probe tool outside allowlist.",
    );
    const c = await connectors.sync(b.connectionId);
    checkCurrentBinding();
    const tool = c.tools.find((t: Json) => t.name === request.probe.toolName);
    ensure(tool, "TOOL_NOT_ALLOWED", "Tool missing.");
    const args = clone(request.probe.arguments);
    for (const key of Object.keys(b.lockedArguments))
      ensure(
        get(args, key) === b.lockedArguments[key],
        "ENVIRONMENT_OVERRIDE_DENIED",
        "Probe arguments must include exact locked resources.",
      );
    const client = await connectors.connect(
      c,
      false,
      Math.min(5000, remaining()),
      checkCurrentBinding,
      signal,
    );
    let response;
    try {
      validate(tool.inputSchema, args);
      // No await between the live revision/revocation check and dispatch.
      checkCurrentBinding();
      response = await client.callTool(
        { name: tool.name, arguments: args },
        { timeout: remaining(), toolDefinition: tool, signal },
      );
      ensure(
        !response.isError && response.structuredContent,
        "BINDING_UNVERIFIED",
        "Probe failed.",
      );
      ensure(
        get(response.structuredContent, request.expectedEnvironmentPointer) ===
          (request.expectedEnvironmentValue ?? b.environment),
        "ENVIRONMENT_MISMATCH",
        "Probe environment evidence differs.",
      );
      ensure(
        (response.structuredContent as Json).environment === undefined || (response.structuredContent as Json).environment === b.environment,
        "ENVIRONMENT_MISMATCH",
        "Normalized probe environment must match the fixed binding.",
      );
    } finally {
      await client.close();
    }
    checkCurrentBinding();
    const synthetic =
      !!c.synthetic ||
      c.syntheticEvidence === true ||
      (response!.structuredContent as Json).synthetic === true;
    if (synthetic)
      repo.put(
        "connections",
        c.id,
        { ...c, syntheticEvidence: true },
        c.revision,
      );
    const next = {
      ...b,
      connectionRevision: c.revision,
      revision: b.revision + 1,
      validationStatus: synthetic ? "MOCK_VERIFIED" : "BINDING_VERIFIED",
      simulationOnly: synthetic,
      verification: {
        at: now(),
        actor: "admin",
        scope: request.scope,
        serverEnforcedReadOnly: true,
        probeHash: hash({ tool: tool.name, args }),
        synthetic,
      },
    };
    repo.put("bindings", b.id, next, b.revision);
    repo.audit("admin", "binding:verify", b.id);
    return data(next);
  });

  app.get("/api/v1/workflows", async () => data(repo.all("workflows").filter(w => !w.deletedAt).map(w => {
    const published = w.defaultVersion && repo.get("versions", w.id + "@" + w.defaultVersion);
    return {
      ...w,
      ...(published?.snapshot?.workflow ? {
        publishedRequirements: workflowRequirements(published.snapshot.workflow),
      } : {}),
    };
  })));
  app.post("/api/v1/workflows", async (req) => {
    const b = body(req, ["workflow"], ["layout"]);
    return data(authoring.saveRaw(b.workflow, undefined, b.layout ?? {}));
  });
  app.get("/api/v1/workflows/:id/draft", async (req) => {
    const w = repo.get("workflows", param(req));
    ensure(w && !w.deletedAt, "NOT_FOUND", "Workflow missing or deleted.", 404);
    return data(w);
  });
  app.put("/api/v1/workflows/:id/draft", async (req) => {
    const b = body(req, ["workflow", "layout"], ["expectedLayoutRevision"]);
    ensure(
      repo.get("workflows", param(req)),
      "NOT_FOUND",
      "Workflow missing; create drafts through the workflow collection.",
      404,
    );
    ensure(
      b.workflow.workflowId === param(req),
      "INPUT_INVALID",
      "Workflow ID is immutable.",
    );
    ensure(b.expectedLayoutRevision===undefined || Number.isSafeInteger(b.expectedLayoutRevision) && b.expectedLayoutRevision>0,
      "INPUT_INVALID","Expected layout revision must be a positive integer.");
    return data(authoring.saveRaw(b.workflow, revision(req), b.layout, b.expectedLayoutRevision));
  });
  app.post("/api/v1/workflows/:id/validate", async (req) => {
    const w = repo.get("workflows", param(req));
    ensure(w && !w.deletedAt, "NOT_FOUND", "Workflow missing or deleted.", 404);
    return data({
      ...engine.validateDraft(w.draft),
      validationEvidence: {
        draftRevision: w.revision, structure: "SUCCEEDED",
        ...authoring.publicationEvidence?.(w.id, w.revision),
      },
    });
  });
  app.post("/api/v1/workflows/:id/publish", async (req) => {
    const b = body(
      req,
      ["expectedRevision", "expectedBindingRevisions"],
      ["changeNote"],
    );
    ensure(
      Number.isInteger(b.expectedRevision) && b.expectedRevision > 0,
      "INPUT_INVALID",
      "Expected draft revision required.",
    );
    ensure(
      b.expectedBindingRevisions &&
        typeof b.expectedBindingRevisions === "object" &&
        !Array.isArray(b.expectedBindingRevisions) &&
        Object.values(b.expectedBindingRevisions).every(
          (value) => Number.isSafeInteger(value) && Number(value) > 0,
        ),
      "INPUT_INVALID",
      "Expected revisions of all reviewed bindings are required.",
    );
    ensure(
      b.changeNote === undefined ||
        (typeof b.changeNote === "string" && b.changeNote.length <= 2000),
      "INPUT_INVALID",
      "Change note must contain at most 2000 characters.",
    );
    return data(
      authoring.publishLegacy(
        param(req),
        b.expectedRevision,
        b.changeNote,
        b.expectedBindingRevisions,
      ),
    );
  });
  app.post("/api/v1/workflows/:id/disable", async (req) => {
    const w = repo.get("workflows", param(req));
    ensure(w && !w.deletedAt, "NOT_FOUND", "Workflow missing or deleted.", 404);
    const b = body(req, ["disabled"]);
    ensure(
      typeof b.disabled === "boolean",
      "INPUT_INVALID",
      "Boolean disabled required.",
    );
    repo.put("workflows", w.id, {
      ...w,
      enabled: !b.disabled,
      revision: w.revision + 1,
    });
    return data({ enabled: !b.disabled });
  });
  app.get("/api/v1/workflows/:id/versions", async (req) =>
    data(repo.all("versions").filter((v) => v.workflowId === param(req))),
  );
  app.post("/api/v1/workflows/:id/select-version", async (req) => {
    const b = body(req, ["version"]),
      w = repo.get("workflows", param(req));
    ensure(w && !w.deletedAt, "NOT_FOUND", "Workflow missing or deleted.", 404);
    ensure(
      w && repo.get("versions", w.id + "@" + b.version),
      "VERSION_MISMATCH",
      "Published version missing.",
      409,
    );
    repo.put("workflows", w.id, {
      ...w,
      defaultVersion: b.version,
      revision: w.revision + 1,
    });
    return data({ version: b.version });
  });
  app.post("/api/v1/workflow-imports/preview", async (req) => {
    const b = body(req, ["workflow"]);
    validateWorkflowShape(b.workflow);
    const draft = { ...b.workflow };
    return data({
      workflow: draft,
      disabled: true,
      notice:
        "Import creates a disabled draft; connections and bindings require independent registration.",
    });
  });
  app.post("/api/v1/workflow-imports/commit", async (req) => {
    const b = body(req, ["workflow"]);
    const w = authoring.saveRaw(b.workflow, undefined, {});
    repo.put("workflows", w.id, { ...w, enabled: false });
    return data({ ...w, enabled: false });
  });
  function validateWorkflowShape(w: Workflow) {
    ensure(
      w && typeof w.workflowId === "string",
      "INPUT_INVALID",
      "Workflow object required.",
    );
    validateWorkflowDocument(w);
  }
  // Import uses the same runtime schema; graph/binding validation is deferred to publish.
  app.get("/api/v1/legacy-workflows", async () => data({
    workflows: repo.all("workflows").filter(w => !w.deletedAt && w.draft?.nodes?.some((n: Json) => n.type === "approval"))
      .map(w => ({ workflowId: w.id, revision: w.revision, source: "draft" })),
    versions: repo.all("versions").filter(v => v.snapshot?.workflow?.nodes?.some((n: Json) => n.type === "approval"))
      .map(v => ({ workflowId: v.workflowId, version: v.version, source: "published" })),
    runs: repo.all("runs").filter(r => r.errorCode === "LEGACY_WORKFLOW_RETIRED")
      .map(r => ({ runId: r.id, state: r.state })),
  }));
  app.post("/api/v1/workflows/:id/migrate-legacy", async (req) => {
    const b = body(req, ["targetId", "expectedRevision"], ["sourceVersion"]);
    const source = repo.get("workflows", param(req));
    ensure(source && source.revision === b.expectedRevision, "REVISION_CONFLICT", "Source changed.", 409);
    const original = b.sourceVersion
      ? repo.get("versions", source.id + "@" + b.sourceVersion)?.snapshot?.workflow : source.draft;
    ensure(original, "VERSION_MISMATCH", "Source version is unavailable.");
    const workflow = withoutLegacyNodes(original);
    workflow.workflowId = b.targetId;
    workflow.version = "1.0.0";
    workflow.name += "（自动执行副本）";
    // Validate the proposal before backup or mutation. Never replace another draft.
    engine.validateDraft(workflow);
    ensure(!repo.get("workflows", workflow.workflowId), "REVISION_CONFLICT", "Target already exists.", 409);
    const directory = await backupDirectory(dataDir, true);
    const backup = join(directory, "pre-workflow-migration-" + id("backup") + ".sqlite");
    await repo.backup(backup);
    return data(repo.tx(() => {
      ensure(repo.get("workflows", source.id)?.revision === b.expectedRevision,
        "REVISION_CONFLICT", "Source changed during backup.", 409);
      const draft = authoring.saveRaw(workflow, undefined, {});
      repo.audit("admin", "legacy-workflow-copy", source.id);
      return { draft, backup, published: false };
    }));
  });
  app.get("/api/v1/runs", async (req) => ({
    ...listRuns(req.query),
    requestId: id("req"),
  }));
  app.post("/api/v1/runs", async (req) => {
    const b = body(req, [
      "workflowId",
      "version",
      "mode",
      "inputs",
      "idempotencyKey",
    ], ["clientId"]);
    const { clientId, ...arguments_ } = b;
    if (clientId !== undefined) {
      const client = repo.get("clients", clientId);
      ensure(client && !client.revoked && client.workflowAllowlist.includes(b.workflowId),
        "WORKFLOW_NOT_AVAILABLE", "Selected host cannot execute this workflow.", 404);
    }
    return data(engine.start(arguments_, clientId ?? "execution"));
  });
  const owner = (runId: string) => {
    const run = repo.get("runs", runId);
    ensure(run, "NOT_FOUND", "Run missing.", 404);
    return run.owner;
  };
  app.get("/api/v1/runs/:id", async (req) => {
    const runId = param(req),
      { after, limit } = eventPageQuery(req.query);
    const runOwner = owner(runId);
    const status = engine.status(runId, runOwner, after, limit);
    return data({
      ...status,
      hostIdentityLabel: runOwner === "execution" ? "本机个人编排身份"
        : repo.get("clients", runOwner)?.label ?? "原受限宿主身份",
      eventCursor: eventCursor(repo, runId, after, limit, status.events),
    });
  });
  const streamEvents = (req: FastifyRequest, reply: Json, initial: number, read: (after: number) => Json[], cursor: (event: Json) => number, intervalMs = 2000) => {
    ensure(!streamsClosing, "SERVICE_STOPPING", "The daemon is stopping.", 503);
    let after=initial,closed=false;
    reply.hijack();reply.raw.writeHead(200,{"Content-Type":"text/event-stream","Cache-Control":"no-store","X-Content-Type-Options":"nosniff"});
    let interval: ReturnType<typeof setInterval>|undefined;
    const cleanup=()=>{closed=true;clearInterval(interval);eventStreams.delete(close);};
    const writable=()=>!closed&&!reply.raw.destroyed&&!reply.raw.writableEnded;
    const close=()=>{if(closed)return;cleanup();if(!reply.raw.destroyed&&!reply.raw.writableEnded)reply.raw.end();};
    eventStreams.set(close,req.headers.cookie);reply.raw.on("close",cleanup);reply.raw.on("error",cleanup);
    const send=()=>{if(!writable()){cleanup();return false;}auth.check(req.headers.cookie);for(const event of read(after)) {
      if(!writable())return false;
      if(reply.raw.writableLength>1048576){close();return false;}
      reply.raw.write("id: "+cursor(event)+"\ndata: "+JSON.stringify(event)+"\n\n");after=cursor(event);
    }return writable();};
    try{if(!send())return;}catch{close();return;}
    interval=setInterval(()=>{try{if(send()&&writable())reply.raw.write(": keepalive\n\n");}catch{close();}},intervalMs);
  };
  app.get("/api/v1/runs/:id/events", async (req, reply) => {
    const runId=param(req);engine.status(runId,owner(runId));
    const page=eventPageQuery(req.query,req.headers["last-event-id"]);
    streamEvents(req,reply,page.after,after=>repo.events(runId,after,page.limit),event=>event.seq);
  });
  app.get("/api/v2/events", async (req,reply) => {
    const q=req.query as Json,after=Number(req.headers["last-event-id"]??q.afterEventId??0);
    ensure(Number.isSafeInteger(after)&&after>=0,"INPUT_INVALID","Invalid event cursor.");
    streamEvents(req,reply,after,cursor=>repo.changes(cursor).map(event=>{
      if((q.taskId&&event.taskId!==q.taskId)||(q.workflowId&&event.workflowId!==q.workflowId))return {eventId:event.eventId,type:"cursor",timestamp:event.timestamp};
      return event;
    }),event=>event.eventId,250);
  });
  app.post("/api/v1/runs/:id/advance", async () => {
    throw new HubError(
      "HOST_AGENT_REQUIRED",
      "Submit Agent results through workflow_advance using the authenticated MCP host.",
      403,
    );
  });
  app.post("/api/v1/runs/:id/cancel", async (req) => {
    const b = body(req, ["expectedRevision", "reason", "idempotencyKey"]);
    return data(engine.cancel({ ...b, runId: param(req) }, owner(param(req))));
  });
  app.post("/api/v1/runs/:id/resume", async (req) =>
    data(engine.resume(param(req))),
  );
  app.post("/api/v1/runs/:id/review", async (req) =>
    data(engine.review(param(req), body(req, ["reason", "idempotencyKey"]))),
  );
  app.get("/api/v1/runs/:id/artifacts/:artifactId", async (req) => {
    const q = req.query as Json,
      offset = Number(q.offset ?? 0),
      maxBytes = Number(q.maxBytes ?? 65536);
    ensure(
      Number.isInteger(offset) &&
        offset >= 0 &&
        Number.isInteger(maxBytes) &&
        maxBytes >= 1 &&
        maxBytes <= 262144,
      "INPUT_INVALID",
      "Invalid chunk bounds.",
    );
    return data(
      engine.readArtifact(
        {
          runId: param(req),
          artifactId: param(req, "artifactId"),
          offset,
          maxBytes,
        },
        owner(param(req)),
      ),
    );
  });
  app.get("/api/v1/runs/:id/artifacts/:artifactId/download", async (req, reply) => {
    const runId = param(req);
    const artifact = engine.artifactContent(runId, param(req, "artifactId"), owner(runId));
    const extensions: Record<string, string> = {
      "text/markdown": "md",
      "text/html": "html",
      "application/json": "json",
      "application/mcp+json": "json",
    };
    const safeId = String(artifact.id).replace(/[^a-zA-Z0-9_-]/g, "_");
    const extension = Object.hasOwn(extensions, artifact.mimeType) ? extensions[artifact.mimeType] : "txt";
    const filename = "flowhub-" + safeId + "." + extension;
    return reply
      .type("application/octet-stream")
      .header("Content-Disposition", `attachment; filename="${filename}"`)
      .header("Cache-Control", "no-store")
      .send(Buffer.from(artifact.content, "utf8"));
  });
  app.post("/api/v1/support-bundles/preview", async () =>
    data(supportPreview()),
  );
  app.post("/api/v1/support-bundles/export", async (req) => {
    const b = body(req, ["previewHash"]);
    const preview = supportPreview();
    ensure(
      b.previewHash === preview.hash,
      "REVISION_CONFLICT",
      "Preview changed; inspect it again.",
      409,
    );
    return data({
      filename: "flowhub-support-" + Date.now() + ".json",
      content: JSON.stringify(preview.content, null, 2),
    });
  });
  function supportPreview() {
    const content = {
      version: VERSION,
      generatedDate: new Date().toISOString().slice(0, 10),
      counts: {
        connections: repo.all("connections").length,
        workflows: repo.all("workflows").filter(w=>!w.deletedAt).length,
        runs: repo.all("runs").length,
      },
      states: repo
        .all("runs")
        .map((r) => ({ state: r.state, errorCode: r.errorCode ?? null })),
      note: "Metadata only. No endpoints, credentials, query inputs, evidence or reports.",
    };
    return { content, hash: hash(content) };
  }
  app.post("/api/v1/backups", async () => {
    const dir = await backupDirectory(dataDir, true);
    const filename = "flowhub-" + Date.now() + "-" + id("backup") + ".sqlite";
    const path = join(dir, filename);
    await repo.backup(path);
    repo.audit("admin", "backup", filename);
    const info = await stat(path);
    return data({
      filename,
      path,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      note: "Contains sensitive state. Keep local; do not upload.",
    });
  });
  app.get("/api/v1/backups", async () => data(await localBackups(dataDir)));
  app.post("/api/v1/backups/preflight", async (req) => {
    const b = body(req, ["filename"]);
    const result = await preflightLocalBackup(dataDir, b.filename);
    return data({
      ...result,
      instructions: result.compatible ? offlineRestoreInstructions({
        runtimePath: process.execPath,
        cliPath: localCliPath,
        dataDir,
        backupPath: result.path,
      }) : null,
    });
  });
  app.post("/api/v1/retention/preview", async () =>
    data(previewRetention(repo)),
  );
  app.post("/api/v1/retention/commit", async (req) => {
    const b = body(req, ["previewHash"]);
    return data(commitRetention(repo, b.previewHash));
  });
  registerV2(app, authoring, registry, application);
  // preClose runs before Fastify waits for hijacked HTTP connections to finish.
  app.addHook("preClose", async () => {
    await registry.close();
    streamsClosing = true;
    for (const close of eventStreams.keys()) close();
  });
  app.addHook("onClose", async () => {
    auth.close();
    vault.lock();
  });
  return { auth };
}
const bindingSchema: Json = {
  type: "object",
  properties: {
    name: { type: "string", minLength: 1, maxLength: 128 },
    connectionId: { type: "string", minLength: 1 },
    environment: { enum: ["production", "staging", "test"] },
    allowedTools: {
      type: "array",
      minItems: 1,
      maxItems: 100,
      items: { type: "string" },
    },
    lockedArguments: { type: "object", minProperties: 1, maxProperties: 32 },
    allowedQueryTemplates: {
      type: "array",
      maxItems: 30,
      items: { type: "string" },
    },
    maxRows: { type: "integer", minimum: 1, maximum: 1000 },
    timeoutSeconds: { type: "integer", minimum: 1, maximum: 120 },
  },
  required: [
    "name",
    "connectionId",
    "environment",
    "allowedTools",
    "lockedArguments",
    "allowedQueryTemplates",
    "maxRows",
    "timeoutSeconds",
  ],
  additionalProperties: false,
};
