import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const { fetchVerifiedArchive, NSIS_DOWNLOADS, validateNsisUrl } = await import(
  pathToFileURL(resolve("scripts/fetch-nsis.mjs")).href
);
const zip = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from("synthetic archive fixture"),
]);
const expectedSha256 = createHash("sha256").update(zip).digest("hex");

test("NSIS fetch rejects HTML, drains redirects without cancellation and only publishes a checksum-verified ZIP", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub-nsis-fetch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "nsis.zip");
  const diagnosticsPath = join(dir, "diagnostics.json");
  let calls = 0;
  let redirectCancelled = false;
  let redirectResponse: Response | undefined;
  const redirectText = Buffer.from("temporary official mirror redirect");
  const redirectBody = new ReadableStream({
    start(controller) {
      controller.enqueue(redirectText);
      controller.close();
    },
    cancel() {
      redirectCancelled = true;
      throw new Error(
        "A normal redirect response must be drained, never cancelled.",
      );
    },
  });
  const result = await fetchVerifiedArchive({
    output,
    expectedSha256,
    candidates: NSIS_DOWNLOADS.slice(0, 2),
    diagnosticsPath,
    fetchImpl: async () => {
      calls++;
      return calls === 1
        ? new Response("<html>download page</html>", {
            headers: { "content-type": "text/html" },
          })
        : calls === 2
          ? (redirectResponse = new Response(redirectBody, {
              status: 302,
              headers: {
                location:
                  "https://netactuate.dl.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip?timestamp=DO_NOT_LOG",
              },
            }))
          : new Response(zip, {
              headers: { "content-type": "application/zip" },
            });
    },
  });
  assert.equal(result.archiveSha256, expectedSha256);
  assert.deepEqual(await readFile(output), zip);
  const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  assert.equal(diagnostics.verified, true);
  assert.equal(diagnostics.attempts[0].errorCode, "NSIS_NOT_ZIP");
  assert.equal(diagnostics.attempts[0].contentType, "text/html");
  assert.ok(diagnostics.attempts[0].sha256);
  assert.equal(calls, 3);
  assert.equal(redirectCancelled, false);
  assert.equal(redirectResponse?.bodyUsed, true);
  assert.equal(diagnostics.attempts[1].redirectBytes, redirectText.length);
  assert.equal(
    diagnostics.attempts[1].redirects[0],
    "https://netactuate.dl.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip",
  );
  assert.equal(JSON.stringify(diagnostics).includes("DO_NOT_LOG"), false);
  assert.equal(JSON.stringify(diagnostics).includes("<html>"), false);
  assert.equal(
    (await readdir(dir)).some((name) => name.includes(".part-")),
    false,
  );
});

test("NSIS fetch retains the prior output and fails closed on corrupt ZIPs or unapproved redirects", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub-nsis-reject-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "nsis.zip");
  await writeFile(output, "existing diagnostic response");
  const diagnosticsPath = join(dir, "diagnostics.json");
  let calls = 0;
  await assert.rejects(
    fetchVerifiedArchive({
      output,
      expectedSha256,
      candidates: NSIS_DOWNLOADS.slice(0, 2),
      diagnosticsPath,
      fetchImpl: async () =>
        ++calls === 1
          ? new Response(Buffer.concat([zip, Buffer.from("TAMPER")]), {
              headers: { "content-type": "application/zip" },
            })
          : new Response(null, {
              status: 302,
              headers: {
                location:
                  "http://example.invalid/nsis.zip?credential=DO_NOT_LOG",
              },
            }),
    }),
    /NSIS_DOWNLOAD_FAILED/,
  );
  assert.equal(calls, 2);
  assert.equal(await readFile(output, "utf8"), "existing diagnostic response");
  const diagnostics = JSON.parse(await readFile(diagnosticsPath, "utf8"));
  assert.equal(diagnostics.verified, false);
  assert.equal(diagnostics.attempts[1].errorCode, "NSIS_SHA256_MISMATCH");
  assert.equal(diagnostics.attempts[2].errorCode, "NSIS_SOURCE_NOT_ALLOWED");
  assert.equal(
    diagnostics.attempts[2].rejectedRedirect,
    "http://example.invalid/nsis.zip",
  );
  assert.equal(JSON.stringify(diagnostics).includes("DO_NOT_LOG"), false);
  assert.equal(
    (await readdir(dir)).some((name) => name.includes(".part-")),
    false,
  );
  assert.throws(
    () =>
      validateNsisUrl(
        "https://unrelated.sourceforge.net/project/nsis/NSIS%203/3.11/nsis-3.11.zip",
      ),
    /NSIS_SOURCE_NOT_ALLOWED/,
  );
  assert.throws(
    () =>
      validateNsisUrl(
        "https://netactuate.dl.sourceforge.net.evil.invalid/project/nsis/NSIS%203/3.11/nsis-3.11.zip",
      ),
    /NSIS_SOURCE_NOT_ALLOWED/,
  );
});

test("NSIS fetch revalidates a trusted local cache without touching the network", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "flowhub-nsis-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const output = join(dir, "nsis.zip");
  await writeFile(output, zip);
  const result = await fetchVerifiedArchive({
    output,
    expectedSha256,
    fetchImpl: async () => {
      throw new Error("Network must not be used");
    },
  });
  assert.equal(result.cached, true);
  assert.equal(result.bytes, zip.length);
});
