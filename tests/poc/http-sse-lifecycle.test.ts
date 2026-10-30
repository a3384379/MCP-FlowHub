import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { get as httpGet, type IncomingMessage } from "node:http";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { startDaemon } from "../../apps/daemon/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";

async function within<T>(operation: Promise<T>, milliseconds = 4000) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("SSE did not close in time")),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function fixture(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub-sse-lifecycle-"));
  const daemon = await startDaemon({ dataDir, port: 0 });
  const responses: IncomingMessage[] = [];
  t.after(async () => {
    for (const response of responses) response.destroy();
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${daemon.port}/api/v1`;
  const bootstrap = await fetch(base + "/auth/bootstrap", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8"),
      password: "Synthetic-sse-lifecycle-password-158",
    }),
  });
  assert.equal(bootstrap.status, 200);
  const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
  const csrf = ((await bootstrap.json()) as Json).data.csrf;
  const api = (
    path: string,
    body?: Json,
    method = body === undefined ? "GET" : "POST",
  ) =>
    fetch(base + path, {
      method,
      headers: {
        Cookie: cookie,
        "X-CSRF-Token": csrf,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const started = await api("/runs", {
    workflowId: "incident-staging",
    version: "1.0.0",
    mode: "guided",
    inputs: {
      question: "合成SSE生命周期检查",
      orderNo: "DEMO-1001",
      from: "2026-10-29T00:00:00Z",
      to: "2026-10-29T00:30:00Z",
    },
    idempotencyKey: "sse-lifecycle",
  });
  assert.equal(started.status, 200);
  const runId = ((await started.json()) as Json).data.runId;
  const open = (sessionCookie = cookie) =>
    new Promise<{ response: IncomingMessage; closed: Promise<void> }>(
      (resolve, reject) => {
        const request = httpGet(
          base + "/runs/" + runId + "/events",
          { headers: { Cookie: sessionCookie } },
          (response) => {
            responses.push(response);
            assert.equal(response.statusCode, 200);
            const closed = new Promise<void>((done) => {
              response.on("end", done);
              response.on("error", reject);
            });
            response.resume();
            resolve({ response, closed });
          },
        );
        request.on("error", reject);
      },
    );
  return { daemon, dataDir, api, open };
}

test("daemon shutdown ends active authenticated SSE and removes endpoint and lock without client disconnect", async (t) => {
  const { daemon, dataDir, open } = await fixture(t);
  const stream = await open();
  assert.equal(stream.response.complete, false);
  await within(Promise.all([daemon.close(), stream.closed]));
  assert.equal(stream.response.complete, true);
  await assert.rejects(access(join(dataDir, "endpoint.json")));
  await assert.rejects(access(join(dataDir, "daemon.lock")));
});

test("administrator logout immediately closes its SSE and preserves another live session", async (t) => {
  const { api, open } = await fixture(t);
  const login = await api("/auth/session", {
    password: "Synthetic-sse-lifecycle-password-158",
  });
  assert.equal(login.status, 200);
  await login.json();
  const anotherCookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const own = await open();
  const another = await open(anotherCookie);
  const logout = await api("/auth/session", undefined, "DELETE");
  assert.equal(logout.status, 200);
  await logout.json();
  await within(own.closed, 1000);
  assert.equal(own.response.complete, true);
  assert.equal(another.response.complete, false);
});

test("an expired administrator session stops receiving SSE on the next heartbeat", async (t) => {
  const { api, open } = await fixture(t);
  const stream = await open();
  const expiredNow = Date.now() + 8 * 3600000 + 1;
  const clock = t.mock.method(Date, "now", () => expiredNow);
  try {
    await within(stream.closed, 3000);
    assert.equal(stream.response.complete, true);
    const denied = await api("/runs");
    assert.equal(denied.status, 401);
    await denied.json();
  } finally {
    clock.mock.restore();
  }
});
