import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, stat, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { request as httpRequest } from "node:http";
import Database from "better-sqlite3";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { readEndpoint } from "../../apps/daemon/src/local-config.js";
import { localHttpTransport } from "../../packages/mcp-connectors/src/index.js";

test("ENV-02/07: WAL persists across restart in Chinese/space paths; duplicate daemon rejected", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "合成 FlowHub data "));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const first = await startDaemon({ dataDir, port: 0 });
  const id = first.instanceId;
  try {
    assert.equal(first.boots, 1);
    await assert.rejects(
      startDaemon({ dataDir, port: 0 }),
      /DAEMON_ALREADY_RUNNING/,
    );
    const db = new Database(join(dataDir, "flowhub.sqlite"), {
      readonly: true,
    });
    try {
      assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    } finally {
      db.close();
    }
  } finally {
    await first.close();
  }
  const second = await startDaemon({ dataDir, port: 0 });
  try {
    assert.equal(second.instanceId, id);
    assert.equal(second.boots, 2);
  } finally {
    await second.close();
  }
  await assert.rejects(access(join(dataDir, "endpoint.json")));
  await assert.rejects(access(join(dataDir, "daemon.lock")));
});

test("ENV-03/04: port conflict is actionable; failed startup releases its lock; loopback only", async (t) => {
  const a = await mkdtemp(join(tmpdir(), "flowhub port a "));
  const b = await mkdtemp(join(tmpdir(), "flowhub port b "));
  const first = await startDaemon({ dataDir: a, port: 0 });
  t.after(async () => {
    await first.close();
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  });
  await assert.rejects(
    startDaemon({ dataDir: b, port: first.port }),
    /PORT_IN_USE/,
  );
  await assert.rejects(access(join(b, "daemon.lock")));
  const health = await fetch(`http://127.0.0.1:${first.port}/api/v1/health`);
  assert.equal(health.status, 200);
  assert.equal(((await health.json()) as { phase: string }).phase, "RC");
});

test("SEC-11/12 S0 subset: bearer auth, DNS rebinding, Origin and management-route denial", async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), "flowhub security "));
  const daemon = await startDaemon({ dataDir, port: 0 });
  t.after(async () => {
    await daemon.close();
    await rm(dataDir, { recursive: true, force: true });
  });
  const { url, token } = await readEndpoint(dataDir);
  const call = (headers: Record<string, string>) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: "{}",
    });
  assert.equal((await call({})).status, 401);
  assert.equal((await call({ Authorization: "Bearer wrong" })).status, 401);
  assert.equal(
    (
      await call({
        Authorization: `Bearer ${token}`,
        Origin: "https://evil.invalid",
      })
    ).status,
    403,
  );
  // Node's fetch normalizes Host; use a raw HTTP request to exercise rebinding.
  const hostileHostStatus = await new Promise<number | undefined>(
    (resolve, reject) => {
      const request = httpRequest(
        url,
        {
          method: "POST",
          headers: {
            Host: `evil.invalid:${daemon.port}`,
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
        },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode));
        },
      );
      request.on("error", reject);
      request.end("{}");
    },
  );
  assert.equal(hostileHostStatus, 403);
  assert.equal(
    (
      await call({
        Authorization: `Bearer ${token}`,
        Origin: `http://127.0.0.1:${daemon.port + 1}`,
      })
    ).status,
    403,
  );
  const approve = await fetch(
    `http://127.0.0.1:${daemon.port}/api/v1/approvals/fake/decision`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: '{"approved":true}',
    },
  );
  assert.equal(approve.status, 404);
  if (process.platform !== "win32") {
    assert.equal(
      (await stat(join(dataDir, "execution-token"))).mode & 0o777,
      0o600,
    );
    assert.equal((await stat(dataDir)).mode & 0o777, 0o700);
  }
  const dbBytes = await readFile(join(dataDir, "flowhub.sqlite"));
  assert.equal(dbBytes.includes(Buffer.from(token)), false);
  assert.throws(
    () => localHttpTransport(new URL("https://example.invalid/mcp"), token),
    /TARGET_DENIED/,
  );
  assert.throws(
    () =>
      localHttpTransport(new URL("http://user:pass@127.0.0.1:100/mcp"), token),
    /TARGET_DENIED/,
  );
});

test("ENV-08: bridge without daemon fails without creating data or polluting stdout", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub absent "));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const entry = resolve("dist/apps/daemon/src/cli.js");
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      entry,
      "mcp",
      "--stdio",
      "--data-dir",
      join(dir, "absent"),
    ]),
    (error: unknown) => {
      const e = error as { code: number; stdout: string; stderr: string };
      assert.equal(e.code, 1);
      assert.equal(e.stdout, "");
      assert.match(e.stderr, /DAEMON_UNAVAILABLE.*serve/);
      return true;
    },
  );
  await assert.rejects(access(join(dir, "absent")));
});

test("CLI rejects unknown options, unknown commands and unsafe port inputs", async () => {
  for (const args of [
    ["serve", "--port", "-1"],
    ["serve", "--port", "65536"],
    ["serve", "--host", "0.0.0.0"],
    ["approve"],
  ]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [
        resolve("dist/apps/daemon/src/cli.js"),
        ...args,
      ]),
    );
  }
});
