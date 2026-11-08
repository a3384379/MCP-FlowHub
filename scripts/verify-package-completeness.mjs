import assert from "node:assert/strict";
import { readFile, readdir, stat, writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../", import.meta.url));
const evidence = resolve(process.env.FLOWHUB_PACKAGE_EVIDENCE_DIR ?? join(root, "artifacts/package-completeness"));
await mkdir(evidence, { recursive: true });
const latest = JSON.parse(await readFile(resolve(process.argv[2] ?? join(root, "artifacts/latest-package.json")), "utf8")), bundle = latest.bundle;
const manifest = JSON.parse(await readFile(join(bundle, "manifest.sha256.json"), "utf8"));
const modules = ["workflow-authoring", "host-discovery", "capability-registry", "assistant-core", "llm-providers", "project-knowledge", "workflow-testing"];
const docs = ["README.md", "docs/HOST_INTEGRATION.md", "docs/V2_USER_GUIDE.md", "docs/DISCOVERY_LOCALIZATION.md"];
const compiled = [], runtimeDocs = [];
async function walk(relative) {
  for (const entry of await readdir(join(bundle, "source", relative), { withFileTypes: true })) {
    const path = relative + "/" + entry.name;
    if (entry.isDirectory()) await walk(path);
    else if (path.endsWith(".ts") && !path.endsWith(".d.ts")) {
      const output = "dist/" + path.slice(0, -3) + ".js";
      assert.ok(manifest[output], "Every new module source must have compiled output: " + output);
      assert.ok((await stat(join(bundle, output))).isFile());
      compiled.push(output);
    }
  }
}
for (const module of modules) await walk("packages/" + module + "/src");
for (const path of ["packages/persistence/src/migrations", "packages/persistence/src/v1", "packages/persistence/src/v2", "packages/persistence/src/v3"]) {
  assert.ok(manifest["dist/" + path + ".js"]); assert.ok(manifest["source/" + path + ".ts"]); compiled.push("dist/" + path + ".js");
}
for (const file of ["contracts/mcp-v2-tool-inputs.schema.json", "contracts/workflow-v2.schema.json", "contracts/authoring-batch.schema.json", "contracts/workflow-delete.schema.json"]) {
  assert.ok(manifest[file]); assert.equal(manifest[file], manifest["source/" + file]);
}
const missing = [];
for (const file of docs) {
  const record = { path: file, runtimeExists: false, sourceExists: !!manifest["source/" + file] };
  try { record.runtimeExists = (await stat(join(bundle, file))).isFile(); } catch {}
  runtimeDocs.push(record);
  if (!record.runtimeExists || !manifest[file]) missing.push(file);
}
if (missing.length) {
  const counterexample = { caseId: "PACK-01", result: "MISSING_PACKAGED_HELP", bundle, archiveSha256: latest.archiveSha256, newRuntimeFilesChecked: compiled.length, docs: runtimeDocs, missing };
  await writeFile(join(evidence, "package-completeness-before.json"), JSON.stringify(counterexample, null, 2));
  assert.fail("Missing runtime help sources: " + missing.join(", "));
}
for (const file of docs) assert.equal(manifest[file], manifest["source/" + file], "runtime/source help bytes must match: " + file);
const runtime = join(bundle, "runtime", process.platform === "win32" ? "node.exe" : "node");
const probe = `import assert from 'node:assert/strict';import {createRequire} from 'node:module';import {join} from 'node:path';import {pathToFileURL} from 'node:url';const root=process.argv[1],require=createRequire(join(root,'package.json')),Database=require('better-sqlite3');const {Repository}=await import(pathToFileURL(join(root,'dist/packages/persistence/src/repository.js'))),{ProjectKnowledge}=await import(pathToFileURL(join(root,'dist/packages/project-knowledge/src/index.js')));const db=new Database(':memory:');try{const repo=new Repository(db),knowledge=new ProjectKnowledge(repo,root),expected=${JSON.stringify(docs)};assert.deepEqual(repo.all('knowledge_documents').map(d=>d.sourcePath).sort(),expected.sort());for(const source of expected)assert.ok(repo.all('knowledge_chunks').some(c=>c.sourcePath===source),'No indexed chunk for '+source);const result=knowledge.search({query:'中文说明同步',limit:20});assert.ok(result.citations.some(c=>c.sourcePath==='docs/DISCOVERY_LOCALIZATION.md'),'Packaged localized guide must be searchable');console.log(JSON.stringify({node:process.versions.node,indexedDocuments:repo.all('knowledge_documents').map(d=>d.sourcePath),knowledgeChunks:repo.all('knowledge_chunks').length,localizationCitation:result.citations.find(c=>c.sourcePath==='docs/DISCOVERY_LOCALIZATION.md')}));}finally{db.close();}`;
const env = Object.fromEntries(["HOME", "TMPDIR", "SystemRoot", "WINDIR", "TEMP", "TMP"].flatMap(key => process.env[key] ? [[key, process.env[key]]] : [])); env.PATH = join(bundle, "runtime");
const indexed = await promisify(execFile)(runtime, ["--input-type=module", "-e", probe, bundle], { cwd: bundle, env, timeout: 15000, maxBuffer: 2 * 1024 * 1024 });
const result = { caseId: "PACK-01", status: "PASS", bundle, archiveSha256: latest.archiveSha256, manifestSha256: createHash("sha256").update(await readFile(join(bundle, "manifest.sha256.json"))).digest("hex"), newRuntimeFilesChecked: compiled.length, compiledFiles: compiled, helpDocuments: runtimeDocs, packagedRuntimeIndex: JSON.parse(indexed.stdout), noGlobalNode: true, hashScope: "Integrity and consistency only; not a signature or enterprise acceptance." };
await writeFile(join(evidence, "package-completeness.receipt.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result, null, 2));
