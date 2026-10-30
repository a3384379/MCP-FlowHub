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
  redact,
  validate,
  clone,
  workflowSchema,
  type Json,
  type Workflow,
} from "../../contracts/src/domain.js";
import { VERSION, TOOL_NAMES, projectRoot } from "../../contracts/src/index.js";
import type { Engine } from "../../workflow-core/src/engine.js";
import { AdminAuth } from "../../security/src/index.js";
import { assertConnectionCredentials } from "../../mcp-connectors/src/connection-config.js";
import { toolAdaptersSchema, decodeToolResult, applyRowBudget, adapterFor, payloadSchema } from "../../contracts/src/tool-adapter.js";
import {
  previewRetention,
  commitRetention,
} from "../../persistence/src/retention.js";
import { backupDirectory, localBackups, preflightLocalBackup } from "./local-backups.js";
import { hostIntegration, localCliPath, offlineRestoreInstructions } from "./settings-integration.js";
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
    if (!path?.startsWith("/api/v1/")) return;
    if (
      (["GET", "HEAD"].includes(req.method) &&
        ["/api/v1/health", "/api/v1/auth/state"].includes(path)) ||
      (req.method === "POST" &&
        ["/api/v1/auth/session", "/api/v1/auth/bootstrap"].includes(path))
    )
      return;
    auth.check(
      req.headers.cookie,
      String(req.headers["x-csrf-token"] ?? ""),
      !["GET", "HEAD", "OPTIONS"].includes(req.method),
    );
  });
  const loginCookie = (reply: Json, session: Json) =>
    reply.header(
      "Set-Cookie",
      "flowhub_session=" +
        session.token +
        "; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800",
    );
  app.get("/api/v1/auth/state", async () =>
    data({
      initialized: auth.initialized,
      vaultInitialized: vault.initialized,
      vaultLocked: vault.locked,
      version: VERSION,
    }),
  );
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
    loginCookie(reply, session);
    return data({ csrf: session.csrf });
  });
  app.post("/api/v1/auth/session", async (req, reply) => {
    const b = body(req, ["password"]),
      session = auth.login(b.password);
    loginCookie(reply, session);
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
  app.post("/api/v1/vault/unlock", async (req) => {
    auth.throttle("vault");
    const b = body(req, ["password"]);
    vault.unlock(b.password);
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
    repo.audit("admin", "vault:change-password", "vault");
    return data({ changed: true });
  });
  app.post("/api/v1/secrets", async (req) => {
    const b = body(req, ["label", "value"]);
    ensure(
      typeof b.label === "string" && b.label.length <= 128,
      "INPUT_INVALID",
      "Invalid secret label.",
    );
    return data(vault.addSecret(b.label, b.value));
  });
  app.get("/api/v1/secrets", async () =>
    data(
      repo
        .all("secrets")
        .map(({ id, label, createdAt }) => ({ id, label, createdAt })),
    ),
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
    const b = body(req, ["label", "workflowAllowlist"]);
    ensure(
      typeof b.label === "string" &&
        b.label.length > 0 &&
        b.label.length <= 128 &&
        Array.isArray(b.workflowAllowlist) &&
        b.workflowAllowlist.length > 0 &&
        b.workflowAllowlist.length <= 100 &&
        b.workflowAllowlist.every(
          (w: Json) => typeof w === "string" && repo.get("workflows", w),
        ),
      "INPUT_INVALID",
      "Label and explicit workflow allowlist required.",
    );
    const token = randomBytes(32).toString("hex"),
      client = {
        id: id("client"),
        label: b.label,
        workflowAllowlist: b.workflowAllowlist,
        scopes: ["workflow:execute"],
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
    validate(connectionSchema, b);
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
    assertConnectionCredentials(c);
    for (const ref of [c.secretRef, ...Object.values(c.envRefs ?? {})].filter(Boolean))
      ensure(typeof ref === "string" && repo.get("secrets", ref), "INPUT_INVALID", "Select an existing Vault credential reference.");
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
      configurationWarning: undefined,
    };
    validate(connectionSchema, Object.fromEntries(Object.keys(connectionSchema.properties)
      .filter((key) => next[key] !== undefined).map((key) => [key, next[key]])));
    assertConnectionCredentials(next);
    for (const ref of [next.secretRef, ...Object.values(next.envRefs ?? {})].filter(Boolean))
      ensure(typeof ref === "string" && repo.get("secrets", ref), "INPUT_INVALID", "Select an existing Vault credential reference.");
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
    return data(connectors.catalogView(next));
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
    data(vault.redact(bindingImpact(repo, param(req)))),
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
    ], ["toolAdapters"]);
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
        "toolAdapters",
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
      ],
      ["expectedEnvironmentPointer", "expectedEnvironmentValue", "sourceAttestation", "serverMaxRows"],
    );
    if (request.expectedEnvironmentPointer !== undefined)
      validate({ type: "string", maxLength: 512, pattern: "^(?:/(?:[^~/]|~[01])*)+$" }, request.expectedEnvironmentPointer);
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
    const selectedAdapter = adapterFor(b, tool.name);
    ensure(!selectedAdapter || payloadSchema(b, tool), "SCHEMA_INVALID", "An adapter requires a business payload Schema before probing.");
    ensure(selectedAdapter?.format !== "text_json" || !tool.outputSchema,
      "SCHEMA_INVALID", "Tools declaring structured output must use a structured adapter.");
    const args = clone(request.probe.arguments);
    if (request.serverMaxRows !== undefined)
      validate({ type: "integer", minimum: 1, maximum: 1000 }, request.serverMaxRows);
    if (b.toolAdapters?.[tool.name])
      applyRowBudget({ ...b, verification: { serverMaxRows: request.serverMaxRows } }, tool.name, args, b.maxRows);
    for (const key of Object.keys(b.lockedArguments))
      ensure(
        get(args, key) === b.lockedArguments[key],
        "ENVIRONMENT_OVERRIDE_DENIED",
        "Probe arguments must include exact locked resources.",
      );
    let response, decoded: Json;
    const source = request.sourceAttestation;
    const sourceAttestation = source ? {
      environment: b.environment, connectionRevision: c.revision, bindingRevision: b.revision + 1,
      adapterHash: hash(b.toolAdapters ?? {}), endpointHash: hash({ endpoint: c.endpoint ?? null,
        command: c.command ?? null, args: c.args ?? [], credentialRef: c.secretRef ?? c.envRefs ?? null }),
      serviceIdentity: source.serviceIdentity, accountScope: source.accountScope, resourceScope: source.resourceScope,
    } : undefined;
    if (source) {
      validate({ type: "object", properties: { serviceIdentity: { type: "string", minLength: 1, maxLength: 1000 },
        accountScope: { type: "string", minLength: 1, maxLength: 1000 }, resourceScope: { type: "string", minLength: 1, maxLength: 1000 } },
        required: ["serviceIdentity", "accountScope", "resourceScope"], additionalProperties: false }, source);
      ensure(hash(vault.redact(source)) === hash(source), "INPUT_INVALID", "Attestation must not contain credentials or private data.");
      ensure(b.environment !== "production" || c.synthetic || c.secretRef || Object.keys(c.envRefs ?? {}).length,
        "BINDING_UNVERIFIED", "Production source attestation requires an independently scoped service credential reference.");
      ensure(b.environment !== "production" || Object.keys(b.lockedArguments).some((pointer) => pointer !== "/environment"),
        "BINDING_UNVERIFIED", "Production source attestation requires fixed resource parameters in addition to an environment label.");
    }
    const client = await connectors.connect(c, false, Math.min(5000, remaining()), checkCurrentBinding, signal);
    try {
      validate(tool.inputSchema, args);
      // No await between the live revision/revocation check and dispatch.
      checkCurrentBinding();
      response = await client.callTool(
        { name: tool.name, arguments: args },
        { timeout: remaining(), toolDefinition: tool, signal },
      );
      decoded = decodeToolResult({ ...b, connectionRevision: c.revision, revision: b.revision + 1,
        verification: { sourceAttestation }, simulationOnly: !!c.synthetic }, tool, response);
      if (b.toolAdapters?.[tool.name]?.environment.source !== "binding") ensure(
        get(decoded, request.expectedEnvironmentPointer ?? selectedAdapter?.environment.pointer ?? "/environment") ===
          (request.expectedEnvironmentValue ?? b.environment),
        "ENVIRONMENT_MISMATCH",
        "Probe environment evidence differs.",
      );
    } finally {
      await client.close();
    }
    checkCurrentBinding();
    const synthetic =
      !!c.synthetic ||
      c.syntheticEvidence === true ||
      decoded!.synthetic === true;
    applyRowBudget({ ...b, simulationOnly: synthetic,
      verification: { serverMaxRows: request.serverMaxRows } }, tool.name, args, b.maxRows);
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
        sourceAttestation,
        ...(request.serverMaxRows === undefined ? {} : { serverMaxRows: request.serverMaxRows }),
      },
    };
    repo.put("bindings", b.id, next, b.revision);
    repo.audit("admin", "binding:verify", b.id);
    return data(next);
  });

  app.get("/api/v1/workflows", async () => data(repo.all("workflows")));
  app.post("/api/v1/workflows", async (req) => {
    const b = body(req, ["workflow"], ["layout"]);
    return data(engine.saveDraft(b.workflow, undefined, b.layout ?? {}));
  });
  app.get("/api/v1/workflows/:id/draft", async (req) => {
    const w = repo.get("workflows", param(req));
    ensure(w, "NOT_FOUND", "Workflow missing.", 404);
    return data(w);
  });
  app.put("/api/v1/workflows/:id/draft", async (req) => {
    const b = body(req, ["workflow", "layout"]);
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
    return data(engine.saveDraft(b.workflow, revision(req), b.layout));
  });
  app.post("/api/v1/workflows/:id/validate", async (req) => {
    const w = repo.get("workflows", param(req));
    ensure(w, "NOT_FOUND", "Workflow missing.", 404);
    return data(engine.validateDraft(w.draft));
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
      engine.publish(
        param(req),
        b.expectedRevision,
        b.changeNote,
        b.expectedBindingRevisions,
      ),
    );
  });
  app.post("/api/v1/workflows/:id/disable", async (req) => {
    const w = repo.get("workflows", param(req));
    ensure(w, "NOT_FOUND", "Workflow missing.", 404);
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
    const w = engine.saveDraft(b.workflow, undefined, {});
    repo.put("workflows", w.id, { ...w, enabled: false });
    return data({ ...w, enabled: false });
  });
  function validateWorkflowShape(w: Workflow) {
    ensure(
      w && typeof w.workflowId === "string",
      "INPUT_INVALID",
      "Workflow object required.",
    );
    validate(workflowSchema, w);
  }
  // Import uses the same runtime schema; graph/binding validation is deferred to publish.
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
    ]);
    ensure(b.mode !== "guided", "HOST_START_REQUIRED",
      "Guided runs must be started by the authenticated MCP host using workflow_start; copy the exact version and inputs from the Web handoff.", 403);
    return data(engine.start(b));
  });
  const owner = (runId: string) => {
    const run = repo.get("runs", runId);
    ensure(run, "NOT_FOUND", "Run missing.", 404);
    return run.owner;
  };
  app.get("/api/v1/runs/:id", async (req) => {
    const runId = param(req),
      { after, limit } = eventPageQuery(req.query);
    const status = engine.status(runId, owner(runId), after, limit);
    return data({
      ...status,
      eventCursor: eventCursor(repo, runId, after, limit, status.events),
    });
  });
  app.get("/api/v1/runs/:id/events", async (req, reply) => {
    ensure(!streamsClosing, "SERVICE_STOPPING", "The daemon is stopping.", 503);
    const runId = param(req);
    engine.status(runId, owner(runId));
    const page = eventPageQuery(req.query, req.headers["last-event-id"]);
    let after = page.after;
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    });
    let interval: ReturnType<typeof setInterval> | undefined;
    const cleanup = () => {
      clearInterval(interval);
      eventStreams.delete(close);
    };
    const close = () => {
      cleanup();
      reply.raw.end();
    };
    eventStreams.set(close, req.headers.cookie);
    reply.raw.on("close", cleanup);
    const send = () => {
      auth.check(req.headers.cookie);
      for (const event of repo.events(runId, after, page.limit)) {
        reply.raw.write(
          "id: " + event.seq + "\ndata: " + JSON.stringify(event) + "\n\n",
        );
        after = event.seq;
      }
    };
    try {
      send();
    } catch {
      close();
      return;
    }
    interval = setInterval(() => {
      try {
        send();
        reply.raw.write(": keepalive\n\n");
      } catch {
        close();
      }
    }, 2000);
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
  app.post("/api/v1/approvals/:id/decision", async (req) =>
    data(
      engine.approve(
        param(req),
        body(req, [
          "decision",
          "actionHash",
          "snapshotHash",
          "expectedRevision",
        ]),
      ),
    ),
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
        workflows: repo.all("workflows").length,
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
  // preClose runs before Fastify waits for hijacked HTTP connections to finish.
  app.addHook("preClose", async () => {
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
    toolAdapters: toolAdaptersSchema,
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

const connectionSchema: Json = {
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
      };
