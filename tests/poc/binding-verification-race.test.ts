import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { McpServer, fromJsonSchema } from "@modelcontextprotocol/server";
import { createLocalHttp } from "../../apps/daemon/src/http.js";
import { startDaemon } from "../../apps/daemon/src/index.js";
import { result } from "../../packages/contracts/src/index.js";
import type { Json } from "../../packages/contracts/src/domain.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

for (const scenario of [
  "binding revoked during discovery",
  "connection disabled during connect",
  "binding revoked during SDK preparation",
] as const) {
  test("verification sends no probe when " + scenario, async (t) => {
    const revokeBinding = scenario !== "connection disabled during connect";
    const dataDir = await mkdtemp(join(tmpdir(), "flowhub-verify-revocation-"));
    let calls = 0;
    const token = "c".repeat(64);
    const downstream = createLocalHttp(() => {
      const server = new McpServer(
        { name: "synthetic-verification-race", version: "1" },
        { capabilities: { tools: {} } },
      );
      server.registerTool(
        "verification_probe",
        {
          inputSchema: fromJsonSchema({
            type: "object",
            properties: {
              environment: { const: "staging" },
              resource: { const: "SYNTHETIC_ONLY" },
            },
            required: ["environment", "resource"],
            additionalProperties: false,
          }),
        },
        async () => {
          calls++;
          return result({ synthetic: true, environment: "staging" });
        },
      );
      return server;
    }, token);
    await downstream.listen({ host: "127.0.0.1", port: 0 });
    const daemon = await startDaemon({ dataDir, port: 0 });
    const resumed = gate();
    t.after(async () => {
      resumed.resolve();
      await daemon.close();
      await downstream.close();
      await rm(dataDir, { recursive: true, force: true });
    });
    const base = `http://127.0.0.1:${daemon.port}/api/v1`;
    const bootstrap = await fetch(base + "/auth/bootstrap", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        setupToken: await readFile(join(dataDir, "admin-setup-token"), "utf8"),
        password: "Synthetic-binding-race-password-482",
      }),
    });
    assert.equal(bootstrap.status, 200);
    const cookie = bootstrap.headers.get("set-cookie")!.split(";")[0]!;
    const csrf = ((await bootstrap.json()) as Json).data.csrf;
    const api = async (
      path: string,
      body?: Json,
      method = body === undefined ? "GET" : "POST",
      extra: Record<string, string> = {},
    ) => {
      const response = await fetch(base + path, {
        method,
        headers: {
          Cookie: cookie,
          "X-CSRF-Token": csrf,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
          ...extra,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, ...((await response.json()) as Json) };
    };
    const secret = await api("/secrets", {
      label: "synthetic race token",
      value: token,
    });
    assert.equal(secret.status, 200);
    const port = (downstream.server.address() as { port: number }).port;
    const connection = await api("/connections", {
      name: "synthetic race service",
      transport: "streamable_http",
      protocolEra: "modern",
      endpoint: `http://127.0.0.1:${port}/mcp`,
      allowedHosts: ["127.0.0.1"],
      secretRef: secret.data.id,
    });
    assert.equal(connection.status, 200);
    const binding = await api("/bindings", {
      name: "synthetic race binding",
      connectionId: connection.data.id,
      environment: "staging",
      allowedTools: ["verification_probe"],
      lockedArguments: {
        "/environment": "staging",
        "/resource": "SYNTHETIC_ONLY",
      },
      allowedQueryTemplates: [],
      maxRows: 1,
      timeoutSeconds: 5,
    });
    assert.equal(binding.status, 200);
    const reached = gate();
    const connectors = daemon.engine.connectors;
    if (scenario === "binding revoked during discovery") {
      const sync = connectors.sync.bind(connectors);
      t.mock.method(connectors, "sync", async (connectionId: string) => {
        const catalog = await sync(connectionId);
        reached.resolve();
        await resumed.promise;
        return catalog;
      });
    } else {
      const connect = connectors.connect.bind(connectors);
      t.mock.method(
        connectors,
        "connect",
        async (
          configuration: Json,
          probe = false,
          timeout?: number,
          beforeDispatch?: () => void,
          signal?: AbortSignal,
        ) => {
          const client = await connect(
            configuration,
            probe,
            timeout,
            beforeDispatch,
            signal,
          );
          if (!probe && configuration.id === connection.data.id) {
            if (scenario === "connection disabled during connect") {
              reached.resolve();
              await resumed.promise;
            } else {
              const call = client.callTool.bind(client);
              t.mock.method(
                client,
                "callTool",
                async (...args: Parameters<typeof client.callTool>) => {
                  reached.resolve();
                  await resumed.promise;
                  return call(...args);
                },
              );
            }
          }
          return client;
        },
      );
    }
    const verification = api("/bindings/" + binding.data.id + "/verify", {
      probe: {
        toolName: "verification_probe",
        arguments: { environment: "staging", resource: "SYNTHETIC_ONLY" },
      },
      serverEnforcedReadOnly: true,
      scope: "isolated synthetic regression fixture",
      expectedEnvironmentPointer: "/environment",
    });
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        reached.promise,
        new Promise<never>((_, reject) => {
          deadline = setTimeout(
            () =>
              reject(
                new Error(
                  "Verification did not reach delayed discovery/connect",
                ),
              ),
            10000,
          );
        }),
      ]);
    } finally {
      clearTimeout(deadline);
    }
    const updated = revokeBinding
      ? await api("/bindings/" + binding.data.id, { revoked: true }, "PATCH", {
          "If-Match": String(binding.data.revision),
        })
      : await api(
          "/connections/" + connection.data.id,
          { disabled: true },
          "PATCH",
          { "If-Match": String(connection.data.revision) },
        );
    assert.equal(updated.status, 200);
    resumed.resolve();
    const denied = await verification;
    assert.equal(denied.status, 409);
    assert.equal(denied.error.code, "BINDING_REVOKED");
    assert.equal(calls, 0);
    const current = daemon.engine.repo.get("bindings", binding.data.id);
    assert.equal(
      current.validationStatus,
      revokeBinding ? "REVOKED" : "UNVERIFIED",
    );
    t.mock.restoreAll();
    if (revokeBinding) {
      const alreadyRevoked = await api(
        "/bindings/" + binding.data.id + "/verify",
        {
          probe: {
            toolName: "verification_probe",
            arguments: { environment: "staging", resource: "SYNTHETIC_ONLY" },
          },
          serverEnforcedReadOnly: true,
          scope: "isolated synthetic regression fixture",
          expectedEnvironmentPointer: "/environment",
        },
      );
      assert.equal(alreadyRevoked.status, 409);
      assert.equal(calls, 0);
    }
    const restored = revokeBinding
      ? await api("/bindings/" + binding.data.id, { revoked: false }, "PATCH", {
          "If-Match": String(current.revision),
        })
      : await api(
          "/connections/" + connection.data.id,
          { disabled: false },
          "PATCH",
          { "If-Match": String(updated.data.revision) },
        );
    assert.equal(restored.status, 200);
    const accepted = await api("/bindings/" + binding.data.id + "/verify", {
      probe: {
        toolName: "verification_probe",
        arguments: { environment: "staging", resource: "SYNTHETIC_ONLY" },
      },
      serverEnforcedReadOnly: true,
      scope: "isolated synthetic regression fixture",
      expectedEnvironmentPointer: "/environment",
    });
    assert.equal(accepted.status, 200, JSON.stringify(accepted));
    assert.equal(accepted.data.validationStatus, "MOCK_VERIFIED");
    assert.equal(calls, 1);
  });
}
