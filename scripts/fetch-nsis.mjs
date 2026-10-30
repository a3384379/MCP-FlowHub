import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { request as httpsRequest } from "node:https";

const root = fileURLToPath(new URL("../", import.meta.url));
export const NSIS_SHA256 =
  "c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1";
const artifactPath = "/project/nsis/NSIS%203/3.11/nsis-3.11.zip";
export const NSIS_DOWNLOADS = Object.freeze([
  `https://downloads.sourceforge.net${artifactPath}`,
  `https://master.dl.sourceforge.net${artifactPath}?viasf=1`,
  `https://netix.dl.sourceforge.net${artifactPath}?viasf=1`,
  `https://pilotfiber.dl.sourceforge.net${artifactPath}?viasf=1`,
  `https://phoenixnap.dl.sourceforge.net${artifactPath}?viasf=1`,
  "https://prdownloads.sourceforge.net/nsis/nsis-3.11.zip",
]);
const allowedHosts = new Set([
  ...NSIS_DOWNLOADS.map((value) => new URL(value).hostname),
  "sourceforge.net",
]);
const allowedPaths = new Set([
  decodeURIComponent(artifactPath),
  "/nsis/nsis-3.11.zip",
  "/projects/nsis/files/NSIS 3/3.11/nsis-3.11.zip/download",
]);
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const zipHeader = (bytes) =>
  bytes.length >= 4 &&
  bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]));
const safeUrl = (value) => {
  const url = new URL(value);
  return `${url.origin}${url.pathname}`;
};
const code = (value) =>
  typeof value === "string" && /^[A-Za-z0-9_]{1,64}$/.test(value)
    ? value
    : "DOWNLOAD_FAILED";
function fail(name, message) {
  throw Object.assign(new Error(`${name}: ${message}`), { code: name });
}

export function validateNsisUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    // SourceForge's selector chooses the active mirror dynamically. Restrict
    // that choice to its single-label download-mirror namespace, never project
    // tenant hosts or arbitrary external domains; the artifact path stays fixed.
    (!allowedHosts.has(url.hostname) &&
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.dl\.sourceforge\.net$/.test(
        url.hostname,
      )) ||
    !allowedPaths.has(decodeURIComponent(url.pathname))
  )
    fail(
      "NSIS_SOURCE_NOT_ALLOWED",
      "Only the fixed HTTPS NSIS 3.11 SourceForge file and mirror paths are allowed.",
    );
  return url;
}

export function validateNsisPin(pin) {
  assert.equal(pin.name, "NSIS");
  assert.equal(pin.version, "3.11");
  assert.equal(pin.archiveName, "nsis-3.11.zip");
  assert.equal(pin.directory, "nsis-3.11");
  assert.equal(
    pin.url,
    "https://prdownloads.sourceforge.net/nsis/nsis-3.11.zip",
  );
  assert.equal(
    pin.sha256,
    NSIS_SHA256,
    "The reviewed NSIS SHA-256 must not be changed to accommodate an unexpected response.",
  );
}

/**
 * Use core HTTPS streams, avoiding Node 24.19's Undici parser assertion on
 * Windows. Omitting agent/TLS overrides preserves https.globalAgent, inherited
 * --use-env-proxy routing, and the configured CA trust. Redirects remain owned
 * by the bounded, allowlisted downloader below.
 */
export function requestNsisOverHttps(
  url,
  { signal, headers },
  requestImpl = httpsRequest,
) {
  return new Promise((resolveResponse, rejectResponse) => {
    let response;
    const request = requestImpl(
      url,
      { method: "GET", signal, headers },
      (incoming) => {
        response = incoming;
        // Prevent an unhandled stream error before the consumer's async iterator
        // attaches; the errored stream still rejects that iterator normally.
        incoming.on("error", () => {});
        resolveResponse({
          status: incoming.statusCode ?? 0,
          headers: {
            get(name) {
              const value = incoming.headers[String(name).toLowerCase()];
              return Array.isArray(value) ? value.join(", ") : (value ?? null);
            },
          },
          body: incoming,
        });
      },
    );
    request.on("error", (error) => {
      response?.destroy(error);
      rejectResponse(error);
    });
    request.end();
  });
}

/** Download bytes only. Nothing is extracted or executed by this helper. */
export async function fetchVerifiedArchive({
  output,
  expectedSha256,
  candidates = NSIS_DOWNLOADS,
  diagnosticsPath,
  fetchImpl = requestNsisOverHttps,
  timeoutMs = 25_000,
  maxBytes = 8 * 1024 * 1024,
  onAttempt = () => {},
}) {
  assert.match(expectedSha256, /^[a-f0-9]{64}$/);
  const destination = resolve(output);
  assert.ok(
    !diagnosticsPath || resolve(diagnosticsPath) !== destination,
    "Download and diagnostics paths must differ.",
  );
  candidates.forEach(validateNsisUrl);
  const diagnostics = {
    tool: "NSIS",
    version: "3.11",
    expectedSha256,
    verified: false,
    attempts: [],
  };
  const report = (record) => {
    diagnostics.attempts.push(record);
    onAttempt(record);
  };
  const save = async () => {
    if (diagnosticsPath) {
      await mkdir(dirname(resolve(diagnosticsPath)), { recursive: true });
      await writeFile(diagnosticsPath, JSON.stringify(diagnostics, null, 2));
    }
  };
  try {
    try {
      const info = await lstat(destination);
      if (!info.isFile() || info.isSymbolicLink())
        fail(
          "NSIS_OUTPUT_UNSAFE",
          "The output path must be a regular file or a new file.",
        );
      if (info.size <= maxBytes) {
        const bytes = await readFile(destination);
        const record = {
          source: "local-cache",
          bytes: bytes.length,
          sha256: sha256(bytes),
          zipHeader: zipHeader(bytes),
        };
        report(record);
        if (record.zipHeader && record.sha256 === expectedSha256) {
          diagnostics.verified = true;
          return {
            archive: destination,
            archiveSha256: record.sha256,
            bytes: record.bytes,
            cached: true,
          };
        }
      } else
        report({
          source: "local-cache",
          bytes: info.size,
          errorCode: "NSIS_TOO_LARGE",
        });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await mkdir(dirname(destination), { recursive: true });
    for (const candidate of candidates) {
      const started = Date.now();
      const record = {
        source: safeUrl(candidate),
        redirects: [],
        redirectBytes: 0,
        bytes: 0,
        complete: false,
      };
      const temporary = `${destination}.part-${randomBytes(8).toString("hex")}`;
      let handle;
      let digest;
      try {
        const signal = AbortSignal.timeout(timeoutMs);
        let url = validateNsisUrl(candidate);
        let response;
        for (let redirects = 0; ; redirects++) {
          response = await fetchImpl(url, {
            redirect: "manual",
            credentials: "omit",
            signal,
            headers: {
              Accept:
                "application/zip, application/octet-stream;q=0.9, */*;q=0.1",
            },
          });
          record.status = response.status;
          record.finalUrl = safeUrl(url);
          record.contentType = (response.headers.get("content-type") ?? "")
            .split(";")[0]
            .slice(0, 100);
          if (![301, 302, 303, 307, 308].includes(response.status)) break;
          const location = response.headers.get("location");
          // Drain normal redirect bodies rather than cancelling them: Node
          // 24.19's Undici parser can assert on a TLS end/cancel race. The same
          // attempt signal and total byte budget cover redirect and ZIP bodies.
          if (response.body) {
            for await (const chunk of response.body) {
              record.redirectBytes += chunk.byteLength;
              if (record.redirectBytes > maxBytes)
                fail(
                  "NSIS_TOO_LARGE",
                  "Redirect responses exceeded the bounded download size.",
                );
            }
          }
          if (!location || redirects >= 5)
            fail(
              "NSIS_REDIRECT_LIMIT",
              "Missing redirect target or too many redirects.",
            );
          const target = new URL(location, url);
          try {
            url = validateNsisUrl(target);
          } catch (error) {
            record.rejectedRedirect = safeUrl(target);
            throw error;
          }
          record.redirects.push(safeUrl(url));
        }
        handle = await open(temporary, "wx");
        digest = createHash("sha256");
        let prefix = Buffer.alloc(0);
        if (!response.body)
          fail("NSIS_EMPTY_RESPONSE", "The response has no body.");
        for await (const chunk of response.body) {
          const bytes = Buffer.from(chunk);
          record.bytes += bytes.length;
          if (record.bytes + record.redirectBytes > maxBytes)
            fail(
              "NSIS_TOO_LARGE",
              "The download exceeded the bounded archive size.",
            );
          if (prefix.length < 4)
            prefix = Buffer.concat([
              prefix,
              bytes.subarray(0, 4 - prefix.length),
            ]);
          digest.update(bytes);
          await handle.writeFile(bytes);
        }
        record.complete = true;
        record.sha256 = digest.digest("hex");
        digest = null;
        record.zipHeader = zipHeader(prefix);
        await handle.close();
        handle = null;
        if (response.status !== 200)
          fail("NSIS_HTTP_STATUS", "The file request did not return HTTP 200.");
        if (!record.zipHeader || /(?:html|xml)/i.test(record.contentType))
          fail(
            "NSIS_NOT_ZIP",
            "The response is an HTML/XML page or lacks the expected ZIP header.",
          );
        if (record.sha256 !== expectedSha256)
          fail(
            "NSIS_SHA256_MISMATCH",
            "The downloaded ZIP does not match the reviewed SHA-256.",
          );
        await rename(temporary, destination);
        diagnostics.verified = true;
        diagnostics.selectedSource = record.finalUrl;
        record.durationMs = Date.now() - started;
        report(record);
        return {
          archive: destination,
          archiveSha256: record.sha256,
          bytes: record.bytes,
          cached: false,
          source: record.finalUrl,
        };
      } catch (error) {
        record.errorCode = code(error.code ?? error.cause?.code ?? error.name);
        if (digest) record.partialSha256 = digest.digest("hex");
        record.durationMs = Date.now() - started;
        report(record);
      } finally {
        await handle?.close();
        await rm(temporary, { force: true });
      }
    }
    fail(
      "NSIS_DOWNLOAD_FAILED",
      "All fixed official sources failed. No downloaded archive was trusted, extracted or executed. Review the recorded status, content type, byte counts and hashes.",
    );
  } finally {
    await save();
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { values } = parseArgs({
      options: {
        output: { type: "string" },
        diagnostics: { type: "string" },
        pin: { type: "string" },
      },
    });
    if (!values.output)
      fail(
        "NSIS_OUTPUT_REQUIRED",
        "Supply --output for the verified toolchain ZIP.",
      );
    const proxyPresent = [
      "HTTP_PROXY",
      "HTTPS_PROXY",
      "http_proxy",
      "https_proxy",
    ].some((name) => Boolean(process.env[name]));
    if (
      proxyPresent &&
      !process.execArgv.includes("--use-env-proxy") &&
      process.env.NODE_USE_ENV_PROXY !== "1"
    )
      fail(
        "NSIS_PROXY_CONFIGURATION_REQUIRED",
        "Run Node 24 with --use-env-proxy so inherited proxy settings are preserved.",
      );
    const pin = JSON.parse(
      await readFile(
        values.pin
          ? resolve(values.pin)
          : join(root, "installer/windows/toolchain.json"),
        "utf8",
      ),
    );
    validateNsisPin(pin);
    const result = await fetchVerifiedArchive({
      output: values.output,
      expectedSha256: pin.sha256,
      diagnosticsPath:
        values.diagnostics ??
        join(root, "artifacts/nsis-download-diagnostics.json"),
      onAttempt: (record) => console.log(JSON.stringify(record)),
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    // Network exceptions may contain proxy URLs; print only controlled error
    // codes/messages and never environment values, headers or response bodies.
    console.error(
      code(error.code ?? error.name),
      error.code?.startsWith("NSIS_")
        ? error.message
        : "The pinned NSIS fetch failed; inspect its safe diagnostics.",
    );
    process.exitCode = 1;
  }
}
