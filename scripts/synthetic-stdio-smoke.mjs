import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { randomBytes } from "node:crypto";
import { performance } from "node:perf_hooks";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";

export function redactSmokeDiagnostic(value) {
  return String(value)
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/\b[a-f0-9]{64}\b/gi, "[REDACTED_HEX]")
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      "[REDACTED_JWT]",
    )
    .replace(
      /((?:token|password|secret|authorization|cookie)\s*["']?\s*[:=]\s*["']?)[^\s"'},;]+/gi,
      "$1[REDACTED]",
    );
}

/**
 * Instrumentation for this repository's synthetic fixture only. The launcher
 * calls the original CLI.main with the original arguments and reserves stderr
 * for startup markers; stdout remains entirely owned by the official SDK.
 *
 * SDK 2.4 deliberately probes transport subclasses in place. That exposes the
 * actual probe process's stderr instead of the base transport's disposable
 * sibling (whose stderr the SDK discards), without implementing MCP framing or
 * negotiation here. The normal user-facing Hub bridge uses the base transport.
 */
export class SyntheticReadyStdioTransport extends StdioClientTransport {
  #begin = performance.now();
  #events = [];
  #lines = [];
  #pending = "";
  #decoder = new StringDecoder("utf8");
  #ready = false;
  #started = false;
  #pid = null;
  #resolveReady;
  #rejectReady;
  #readiness;
  #tag;
  #timeout;
  #onDiagnostic;

  constructor(
    { command, entry, args, cwd, env },
    { startupTimeoutMs = 12_000, onDiagnostic = () => {} } = {},
  ) {
    const tag = `FLOWHUB_SYNTHETIC_SMOKE_${randomBytes(12).toString("hex")}`;
    const code = `const mark=event=>process.stderr.write(${JSON.stringify(tag)}+' '+JSON.stringify({event,uptimeMs:Math.round(performance.now())})+String.fromCharCode(10));mark('BOOT');try{const{main}=await import(${JSON.stringify(pathToFileURL(resolve(entry)).href)});mark('CLI_IMPORTED');await main(${JSON.stringify(args)});mark('READY');}catch(error){mark('FAILED');console.error(error instanceof Error?error.stack:String(error));process.exitCode=1;}`;
    super({
      command,
      args: ["--input-type=module", "-e", code],
      cwd,
      env,
      stderr: "pipe",
    });
    this.#tag = tag;
    this.#timeout = startupTimeoutMs;
    this.#onDiagnostic = onDiagnostic;
    this.#readiness = new Promise((resolveReady, rejectReady) => {
      this.#resolveReady = resolveReady;
      this.#rejectReady = rejectReady;
    });
    // A process can fail while super.start() is resolving its spawn event.
    this.#readiness.catch(() => {});
    this.stderr.on("data", (bytes) =>
      this.#consume(this.#decoder.write(bytes)),
    );
    this.onclose = () => {
      this.#consume(this.#decoder.end() + "\n");
      this.#record("closed");
      if (!this.#ready)
        this.#rejectReady(
          Object.assign(
            new Error(
              "SMOKE_STARTUP_EXITED: The synthetic fixture exited before CLI readiness. Inspect its sanitized stderr diagnostics.",
            ),
            { code: "SMOKE_STARTUP_EXITED" },
          ),
        );
    };
    this.onerror = (error) => {
      this.#record("transport-error", {
        code: redactSmokeDiagnostic(error.code ?? error.name),
      });
      if (!this.#ready) this.#rejectReady(error);
    };
  }

  #record(event, detail = {}) {
    const record = {
      event,
      elapsedMs: Math.round(performance.now() - this.#begin),
      pid: this.#pid,
      ...detail,
    };
    this.#events.push(record);
    try {
      this.#onDiagnostic(record);
    } catch {
      /* Diagnostics must never change wire behavior. */
    }
  }

  #consume(text) {
    this.#pending += text;
    let end;
    while ((end = this.#pending.indexOf("\n")) >= 0) {
      const line = this.#pending.slice(0, end).replace(/\r$/, "");
      this.#pending = this.#pending.slice(end + 1);
      if (line.startsWith(`${this.#tag} `)) {
        try {
          const marker = JSON.parse(line.slice(this.#tag.length + 1));
          if (
            ["BOOT", "CLI_IMPORTED", "READY", "FAILED"].includes(marker.event)
          ) {
            this.#record(marker.event, { childUptimeMs: marker.uptimeMs });
            if (marker.event === "READY") {
              this.#ready = true;
              this.#resolveReady();
            }
            continue;
          }
        } catch {
          /* Preserve an invalid marker as sanitized stderr. */
        }
      }
      if (line) {
        this.#lines.push(
          line.length <= 4096
            ? redactSmokeDiagnostic(line)
            : "[oversized stderr line omitted]",
        );
        if (this.#lines.length > 32) this.#lines.shift();
      }
    }
    if (this.#pending.length > 4096)
      this.#pending = "[oversized stderr line omitted]";
  }

  async start() {
    if (this.#started)
      throw new Error("Synthetic smoke transports are single-use.");
    this.#started = true;
    this.#record("start");
    let timer;
    try {
      const startup = (async () => {
        await super.start();
        this.#pid = this.pid;
        this.#record("spawned");
        await this.#readiness;
      })();
      await Promise.race([
        startup,
        new Promise((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                Object.assign(
                  new Error(
                    `SMOKE_STARTUP_TIMEOUT: CLI readiness was not reached within ${this.#timeout}ms; the MCP probe has not started.`,
                  ),
                  { code: "SMOKE_STARTUP_TIMEOUT" },
                ),
              ),
            this.#timeout,
          );
        }),
      ]);
    } catch (error) {
      this.#record("startup-failed", {
        code: redactSmokeDiagnostic(error.code ?? error.name),
      });
      await super.close();
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  async send(message) {
    // Observe method names only: never log envelopes, arguments or result data.
    this.#record("send", { method: message.method ?? "response" });
    return super.send(message);
  }

  diagnostics() {
    return {
      syntheticFixtureInstrumentation: true,
      startupTimeoutMs: this.#timeout,
      ready: this.#ready,
      pid: this.#pid,
      events: [...this.#events],
      stderr: [...this.#lines],
    };
  }
}
