import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {resolve,relative,isAbsolute} from "node:path";
import {fileURLToPath,pathToFileURL} from "node:url";
import {createHash} from "node:crypto";

const sha=bytes=>createHash("sha256").update(bytes).digest("hex");
export async function verifyMatrix(root,ledger) {
  const read=async path=>{
    assert.equal(typeof path,"string");
    const target=resolve(root,path),rel=relative(root,target);
    assert.ok(!isAbsolute(path)&&rel&&!rel.startsWith("..")&&!isAbsolute(rel),"Evidence path must remain inside the checkout");
    return readFile(target);
  };
  const designBytes=await read("docs/upgrade-v2/examples/acceptance-matrix.design.json"),design=JSON.parse(designBytes);
  assert.equal(ledger.format,"flowhub.v2.acceptance/2");assert.equal(design.length,104);assert.equal(ledger.designSha256,sha(designBytes));
  assert.equal(ledger.items.length,104);assert.equal(new Set(ledger.items.map(item=>item.id)).size,104);
  assert.deepEqual(ledger.items.map(item=>item.id).sort(),design.map(item=>item.id).sort());
  const runs=new Map();
  for(const [id,run] of Object.entries(ledger.runs)) {
    assert.equal(run.exitCode,0,"A failed run cannot establish current acceptance: "+id);
    const bytes=await read(run.receiptFile);assert.equal(sha(bytes),run.receiptSha256,"Evidence bytes changed: "+id);
    const receipt=JSON.parse(bytes);runs.set(id,receipt);
    if(receipt.tests) {
      assert.ok(receipt.tests.length>0);assert.ok(receipt.tests.every(test=>test.status==="PASS"&&!test.skip&&!test.todo&&(!test.attempts||test.attempts===1)),"Skipped, failed or retried tests cannot establish a clean full run: "+id);
      assert.equal(receipt.summary.failed,0);assert.equal(receipt.summary.skipped,0);assert.equal(receipt.summary.passed,receipt.tests.length);
    }
    assert.ok(receipt.executionSnapshot?.sourceFiles,"Each run needs its captured execution-source manifest: "+id);
    for(const [file,expected] of Object.entries(receipt.executionSnapshot.sourceFiles))
      assert.equal(sha(await read(file)),expected,"Run input source changed after execution: "+id+" "+file);
  }
  const summary={PASS:0,PARTIAL:0,UNVERIFIED:0,FAIL:0};
  for(const item of ledger.items) {
    const original=design.find(row=>row.id===item.id);assert.equal(item.expected,original.expected,item.id+" changed the acceptance condition");
    assert.ok(Object.hasOwn(summary,item.status));summary[item.status]++;
    assert.ok(typeof item.actual==="string"&&item.actual.length>0);assert.ok(Array.isArray(item.limits));
    if(item.status!=="PASS")assert.ok(item.limits.length>0,item.id+" needs an explicit limitation");
    if(item.status==="PASS")assert.ok(item.exactTests.length+(item.scriptRefs?.length??0)>0,item.id+" has no execution evidence");
    for(const test of item.exactTests) {
      const bytes=await read(test.file);assert.equal(sha(bytes),test.sourceSha256,"Reviewed source changed: "+item.id+" "+test.file);
      const lines=bytes.toString("utf8").split("\n");assert.ok(test.assertionLines.length>0);assert.ok(test.assertionLines.every(line=>Number.isInteger(line)&&line>=1&&line<=lines.length));
      const run=runs.get(test.runId);assert.ok(run?.tests,"Missing named-test run: "+item.id);
      assert.equal(run.executionSnapshot.sourceFiles[test.file],test.sourceSha256,"Passed receipt belongs to different source: "+item.id);
      assert.ok(run.tests.some(actual=>actual.file===test.file&&actual.name===test.name&&actual.status==="PASS"),"No matching passed test: "+item.id+" "+test.name);
    }
    for(const reference of item.scriptRefs??[]) {
      const run=runs.get(reference.runId);assert.ok(run,"Missing script receipt: "+item.id);
      assert.equal(sha(await read(reference.file)),reference.sourceSha256,"Script source changed: "+item.id);
      assert.equal(run.executionSnapshot.sourceFiles[reference.file],reference.sourceSha256,"Script receipt belongs to different source: "+item.id);
      let actual=run;for(const key of reference.path??[])actual=actual?.[key];
      assert.notEqual(actual,undefined,"Missing script observation: "+item.id);assert.deepEqual(actual,reference.expected,"Script observation does not establish acceptance: "+item.id);
    }
    if(["DISC-07","PACK-03","PACK-07"].includes(item.id)&&!ledger.external.nativeWindowsVerified)assert.notEqual(item.status,"PASS",item.id+" requires native external evidence");
    if(item.id==="PACK-08"&&!ledger.external.newMachineVerified)assert.notEqual(item.status,"PASS","A disposable directory is not a new machine");
    if(item.id==="BASE-08"&&ledger.knownLimits.legacyBootstrapWritesOnMismatch)assert.notEqual(item.status,"PASS","Do not conceal the immutable legacy bootstrap counterexample");
  }
  assert.deepEqual(ledger.summary,summary,"Summary must be derived from all 104 items");
  return {items:104,summary,runs:runs.size,sourceAndReceiptHashesVerified:true};
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url) {
  const root=fileURLToPath(new URL("../",import.meta.url));
  const ledger=JSON.parse(await readFile(resolve(process.argv[2]??resolve(root,"docs/evidence/v2/acceptance-results.json")),"utf8"));
  console.log(JSON.stringify(await verifyMatrix(root,ledger),null,2));
}
