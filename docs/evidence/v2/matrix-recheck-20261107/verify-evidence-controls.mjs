import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const root=process.cwd();
const {verifyMatrix}=await import(pathToFileURL(root+'/scripts/verify-v2-matrix.mjs'));
const ledger=JSON.parse(await readFile(root+'/docs/evidence/v2/acceptance-results.json','utf8'));
const positive=await verifyMatrix(root,ledger),cases=[];
const dir='artifacts/matrix-recheck-20261106/root/negative-controls';await mkdir(root+'/'+dir,{recursive:true});
async function reject(name,mutate){const clone=structuredClone(ledger);await mutate(clone);let error;try{await verifyMatrix(root,clone);}catch(e){error=e;}assert.ok(error,'Invalid evidence was accepted: '+name);cases.push({name,rejected:true,error:String(error.message).slice(0,400)});}
await reject('one of 104 IDs removed',x=>x.items.pop());
await reject('acceptance condition silently relaxed',x=>x.items[0].expected='replaced condition');
await reject('test source SHA does not match',x=>x.items.find(i=>i.exactTests.length).exactTests[0].sourceSha256='0'.repeat(64));
await reject('native Windows marked PASS without native evidence',x=>{x.items.find(i=>i.id==='DISC-07').status='PASS';});
await reject('legacy bootstrap counterexample concealed',x=>{x.items.find(i=>i.id==='BASE-08').status='PASS';});
async function changeReceipt(x,id,name,fn){const run=x.runs[id],value=JSON.parse(await readFile(root+'/'+run.receiptFile,'utf8'));fn(value);const file=dir+'/'+name+'.json',bytes=JSON.stringify(value);await writeFile(root+'/'+file,bytes);run.receiptFile=file;run.receiptSha256=createHash('sha256').update(bytes).digest('hex');}
await reject('named passing test missing despite matching counts',async x=>changeReceipt(x,'backend-full','missing-test',v=>{const ref=x.items.find(i=>i.id==='AUTHOR-01').exactTests[0];v.tests=v.tests.filter(t=>!(t.file===ref.file&&t.name===ref.name));v.summary.passed=v.tests.length;}));
await reject('UI skip promoted to PASS',async x=>changeReceipt(x,'ui-full','skip',v=>{v.tests[0].skip=true;}));
await reject('execution input source changed',async x=>changeReceipt(x,'backend-full','stale-source',v=>{v.executionSnapshot.sourceFiles['scripts/benchmark-v2.mjs']='0'.repeat(64);}));
const result={command:'node docs/evidence/v2/matrix-recheck-20261107/verify-evidence-controls.mjs',exitCode:0,positive,negativeControls:cases,failedEvidenceCannotEstablishPass:true};
await writeFile(root+'/docs/evidence/v2/matrix-recheck-20261107/matrix-verifier-results.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify({positive,negativeRejected:cases.length}));
