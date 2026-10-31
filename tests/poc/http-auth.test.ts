import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import type { Json } from "../../packages/contracts/src/domain.js";
import {
  createClient,
  localHttpTransport,
} from "../../packages/mcp-connectors/src/index.js";

const password = "Synthetic-http-auth-password-428";
const inputs = {
  question: "合成鉴权回归订单",
  orderNo: "DEMO-1001",
  from: "2026-10-29T00:00:00Z",
  to: "2026-10-29T00:30:00Z",
};

// Keep the request target intact: fetch normalizes absolute and encoded URLs.
function raw(
  port: number,
  target: string,
  body?: Json,
  headers: Record<string, string> = {},
  method = body === undefined ? "GET" : "POST",
) {
  return new Promise<{
    status: number;
    json: Json;
    text: string;
    headers: IncomingHttpHeaders;
  }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: target,
        method,
        headers: {
          Host: `127.0.0.1:${port}`,
          Accept: "application/json, text/event-stream",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...headers,
        },
      },
      (response) => {
        let text = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (text += chunk));
        response.on("error", reject);
        response.on("end", () => {
          let json: Json;
          try {
            json = JSON.parse(text);
          } catch {
            for (const line of text.split(/\r?\n/)) {
              if (line.startsWith("data:")) json = JSON.parse(line.slice(5));
            }
          }
          resolve({
            status: response.statusCode!,
            json,
            text,
            headers: response.headers,
          });
        });
      },
    );
    request.setTimeout(5000, () => request.destroy(new Error("HTTP timeout")));
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

function adminTargets(port: number, path: string) {
  const encoded = path.replace("/api/v1/", "/a%70i/v%31/");
  return [
    path,
    `http://127.0.0.1:${port}${path}`,
    encoded,
    `http://127.0.0.1:${port}${encoded}?auth-regression=1`,
  ];
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-http-auth-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  t.after(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = (
    target: string,
    body?: Json,
    headers: Record<string, string> = {},
    method?: string,
  ) => raw(daemon.port, target, body, headers, method);
  const setupToken = await readFile(join(dataDir, "admin-setup-token"), "utf8");
  const setup = await call(
    `http://127.0.0.1:${daemon.port}/a%70i/v%31/auth/bootstrap`,
    { setupToken, password },
  );
  assert.equal(setup.status, 200);
  const cookie = setup.headers["set-cookie"]![0]!.split(";")[0]!;
  const adminHeaders = { Cookie: cookie, "X-CSRF-Token": setup.json.data.csrf };
  const token = await readFile(join(dataDir, "execution-token"), "utf8");
  const api = async (path: string, body?: Json) => {
    const response = await call("/api/v1" + path, body, adminHeaders);
    assert.equal(response.status, 200, JSON.stringify(response.json));
    return response.json.data;
  };
  return { daemon, call, api, dataDir, cookie, adminHeaders, token };
}

test("SEC-11/12: matched admin routes require session and CSRF for canonical, absolute and encoded targets", async (t) => {
  const { daemon, call, api, cookie, adminHeaders, token } = await fixture(t);
  const run = await api("/runs", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs,
    idempotencyKey: "http-auth-checkpoint",
  });
  const waitFor = async (state: string) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const current = await api("/runs/" + run.runId);
      if (current.state === state) return current;
      assert.ok(
        !["FAILED", "OUTCOME_UNKNOWN", "BLOCKED"].includes(current.state),
      );
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("Timed out waiting for " + state);
  };
  let current = await waitFor("WAITING_AGENT");
  for (const target of adminTargets(daemon.port, "/api/v1/runs/" + run.runId)) {
    const denied = await call(target);
    assert.equal(denied.status, 401, target);
    assert.equal(denied.json.error.code, "AUTH_REQUIRED");
    assert.equal(denied.json.data?.checkpoint, undefined);
    const allowed = await call(target, undefined, adminHeaders);
    assert.equal(allowed.status, 200, target);
    assert.equal(allowed.json.data.checkpoint.token, current.checkpoint.token);
  }
  const clientBody = {
    label: "http auth regression",
    workflowAllowlist: ["incident-staging"],
  };
  const before = daemon.engine.repo.all("clients").length;
  for (const target of adminTargets(daemon.port, "/api/v1/clients")) {
    assert.equal((await call(target, clientBody)).status, 401, target);
    assert.equal(
      (await call(target, clientBody, { Authorization: "Bearer " + token }))
        .status,
      401,
      target,
    );
    const noCsrf = await call(target, clientBody, { Cookie: cookie });
    assert.equal(noCsrf.status, 403, target);
    assert.equal(noCsrf.json.error.code, "CSRF_DENIED");
    assert.equal(
      (
        await call(target, clientBody, {
          Cookie: cookie,
          "X-CSRF-Token": "wrong",
        })
      ).status,
      403,
      target,
    );
    assert.equal(daemon.engine.repo.all("clients").length, before);
  }
  // A valid alternate target must still reach the registered write handler.
  const written = await call(
    adminTargets(daemon.port, "/api/v1/clients")[3]!,
    clientBody,
    adminHeaders,
  );
  assert.equal(written.status, 200);
  assert.equal(daemon.engine.repo.all("clients").length, before + 1);

  const submission = {
    runId: run.runId,
    checkpointId: current.checkpoint.id,
    checkpointToken: current.checkpoint.token,
    expectedRevision: current.revision,
    idempotencyKey: "http-auth-advance",
    submission: {
      type: "agent_result",
      payload: {
        queryNeeded: true,
        orderNo: inputs.orderNo,
        reason: "合成权限测试",
        evidenceRefs: [current.artifacts[0].id],
      },
    },
  };
  for (const target of adminTargets(
    daemon.port,
    "/api/v1/runs/" + run.runId + "/advance",
  )) {
    const denied = await call(target, submission, adminHeaders);
    assert.equal(denied.status, 403, target);
    assert.equal(denied.json.error.code, "HOST_AGENT_REQUIRED");
    const unchanged = await api("/runs/" + run.runId);
    assert.equal(unchanged.revision, current.revision);
    assert.equal(unchanged.checkpoint.token, current.checkpoint.token);
  }
  const host = createClient("modern", "authenticated-agent-regression");
  t.after(() => host.close());
  await host.connect(
    localHttpTransport(new URL(`http://127.0.0.1:${daemon.port}/mcp`), token),
  );
  const accepted = await host.callTool({
    name: "workflow_advance",
    arguments: submission,
  });
  assert.notEqual(accepted.isError, true, JSON.stringify(accepted));
  current = await waitFor("WAITING_AGENT");
  assert.equal(current.checkpoint.nodeId, "synthesize");
  assert.equal(current.steps.db, "SUCCEEDED");
  const removed = await call("/api/v1/approvals/removed/decision", { decision: "approve" }, adminHeaders);
  assert.equal(removed.status, 404);

});

test("draft PUT updates only an existing stable workflow ID and enforces its revision", async (t) => {
  const { daemon, call, api, adminHeaders } = await fixture(t);
  const original = await api("/workflows/incident-staging/draft");
  const renamed = structuredClone(original.draft);
  renamed.workflowId = "synthetic-renamed-draft";
  const headers = { ...adminHeaders, "If-Match": String(original.revision) };
  const missing = await call(
    "/api/v1/workflows/" + renamed.workflowId + "/draft",
    { workflow: renamed, layout: {} },
    headers,
    "PUT",
  );
  assert.equal(missing.status, 404);
  assert.equal(
    daemon.engine.repo.get("workflows", renamed.workflowId),
    undefined,
  );
  const mismatched = await call(
    "/api/v1/workflows/incident-staging/draft",
    { workflow: renamed, layout: {} },
    headers,
    "PUT",
  );
  assert.equal(mismatched.status, 422);
  const stale = await call(
    "/api/v1/workflows/incident-staging/draft",
    { workflow: original.draft, layout: {} },
    { ...headers, "If-Match": String(original.revision + 10) },
    "PUT",
  );
  assert.equal(stale.status, 409);
  assert.deepEqual(
    daemon.engine.repo.get("workflows", "incident-staging"),
    original,
  );
});

test("publish requires the reviewed draft revision and cannot publish a concurrent save", async (t) => {
  const { daemon, call, api, adminHeaders } = await fixture(t);
  const workflow = structuredClone(
    (await api("/workflows/incident-staging/draft")).draft,
  );
  workflow.workflowId = "synthetic-publish-cas";
  const saved = await api("/workflows", { workflow });
  const expectedBindingRevisions = Object.fromEntries(
    Object.values(workflow.bindings).map((ref) => [
      ref,
      daemon.engine.repo.get("bindings", String(ref)).revision,
    ]),
  );
  const path = "/api/v1/workflows/" + workflow.workflowId;
  const missingRevision = await call(path + "/publish", {}, adminHeaders);
  assert.equal(missingRevision.status, 422);
  workflow.name = "Concurrent save must be reviewed before publication";
  const concurrent = await call(
    path + "/draft",
    { workflow, layout: {} },
    {
      ...adminHeaders,
      "If-Match": String(saved.revision),
    },
    "PUT",
  );
  assert.equal(concurrent.status, 200);
  const stale = await call(
    path + "/publish",
    { expectedRevision: saved.revision, expectedBindingRevisions },
    adminHeaders,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.json.error.code, "REVISION_CONFLICT");
  assert.equal(
    daemon.engine.repo.get(
      "versions",
      workflow.workflowId + "@" + workflow.version,
    ),
    undefined,
  );
  const accepted = await call(
    path + "/publish",
    {
      expectedRevision: concurrent.json.data.revision,
      expectedBindingRevisions,
      changeNote: "Reviewed concurrent save",
    },
    adminHeaders,
  );
  assert.equal(accepted.status, 200);
  assert.equal(accepted.json.data.snapshot.workflow.name, workflow.name);
  assert.equal(accepted.json.data.changeNote, "Reviewed concurrent save");
});

test("public health, auth and static routes stay available; admin session and schema routes stay protected", async (t) => {
  const { daemon, call, cookie } = await fixture(t);
  for (const path of ["/api/v1/health", "/api/v1/auth/state"]) {
    for (const target of adminTargets(daemon.port, path))
      assert.equal((await call(target)).status, 200, target);
  }
  for (const path of ["/api/v1/auth/session", "/api/v1/openapi.json"]) {
    for (const target of adminTargets(daemon.port, path)) {
      assert.equal((await call(target)).status, 401, target);
      assert.equal(
        (await call(target, undefined, { Cookie: cookie })).status,
        200,
        target,
      );
    }
  }
  const login = await call(
    `http://127.0.0.1:${daemon.port}/api/v1/auth/s%65ssion`,
    { password },
  );
  assert.equal(login.status, 200);
  assert.ok(login.json.data.csrf);
  assert.equal((await call("/")).status, 200);
  assert.equal((await call("/workflows")).status, 200);
  assert.equal((await call("/api/v1/unknown")).status, 404);
  assert.equal((await call("/assets/missing-auth-regression.js")).status, 404);
  assert.equal(
    (await call("/api/v1/health", undefined, { Host: "evil.invalid" })).status,
    403,
  );
  assert.equal(
    (
      await call("/api/v1/health", undefined, {
        Origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
});

test("MCP route authentication covers encoded and absolute targets and preserves scoped host identity", async (t) => {
  const { daemon, call, api, dataDir, token } = await fixture(t);
  const created = await api("/clients", {
    label: "scoped HTTP authentication regression",
    workflowAllowlist: ["incident-staging"],
  });
  const scoped = await readFile(join(dataDir, created.tokenFile), "utf8");
  const initialize = {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-11-25",
      capabilities: {},
      clientInfo: { name: "http-auth-regression", version: "1" },
    },
  };
  const list = { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} };
  const get = (workflowId: string) => ({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: { name: "workflow_get", arguments: { workflowId } },
  });
  const targets = [
    "/mcp",
    "/m%63p",
    "/%6dcp",
    `http://127.0.0.1:${daemon.port}/mcp`,
    `http://127.0.0.1:${daemon.port}/%6d%63p?auth-regression=1`,
  ];
  for (const target of targets) {
    for (const body of [initialize, list]) {
      assert.equal((await call(target, body)).status, 401, target);
      assert.equal(
        (await call(target, body, { Authorization: "Bearer wrong" })).status,
        401,
        target,
      );
    }
    for (const method of ["GET", "DELETE"])
      assert.equal(
        (await call(target, undefined, {}, method)).status,
        401,
        target,
      );
    const authenticated = await call(target, list, {
      Authorization: "Bearer " + token,
    });
    assert.equal(authenticated.status, 200, target);
    assert.equal(authenticated.json.result.tools.length, 7, target);
    const scopedHeaders = { Authorization: "Bearer " + scoped };
    const allowed = await call(target, get("incident-staging"), scopedHeaders);
    assert.equal(allowed.status, 200, target);
    assert.notEqual(allowed.json.result.isError, true, target);
    const denied = await call(
      target,
      get("incident-production"),
      scopedHeaders,
    );
    assert.equal(denied.status, 200, target);
    assert.equal(denied.json.result.isError, true, target);
  }
  await api("/clients/" + created.id + "/revoke", {});
  assert.equal(
    (await call(targets[4]!, list, { Authorization: "Bearer " + scoped }))
      .status,
    401,
  );
});

test("MCP factory fails closed when the adapter receives no authentication context", async (t) => {
  let factoryCalls = 0;
  const token = "synthetic-context-token";
  const app = createLocalHttp(() => {
    factoryCalls++;
    throw new Error("Factory must not receive a default identity.");
  }, token);
  // Simulate a lost middleware context after the route accepts a valid token.
  app.addHook("preHandler", async (request) => {
    delete (request.raw as typeof request.raw & { auth?: unknown }).auth;
  });
  t.after(() => app.close());
  await app.listen({ host: "127.0.0.1", port: 0 });
  const port = (app.server.address() as { port: number }).port;
  for (const version of ["2025-11-25", "2026-07-28"]) {
    const response = await raw(
      port,
      "/m%63p",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params:
          version === "2026-07-28"
            ? {
                _meta: {
                  [PROTOCOL_VERSION_META_KEY]: version,
                  [CLIENT_INFO_META_KEY]: {
                    name: "http-auth-regression",
                    version: "1",
                  },
                  [CLIENT_CAPABILITIES_META_KEY]: {},
                },
              }
            : {},
      },
      {
        Authorization: "Bearer " + token,
        "MCP-Protocol-Version": version,
        "Mcp-Method": "tools/list",
      },
    );
    assert.equal(response.status, 500, version + ": " + response.text);
    assert.ok(response.json.error);
    assert.equal(factoryCalls, 0);
  }
});
