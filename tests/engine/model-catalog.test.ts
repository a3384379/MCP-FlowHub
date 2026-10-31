import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {createServer} from "node:http";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";
import {fetchModelCatalog,HttpModelProvider,providerUrl} from "../../packages/llm-providers/src/index.js";

test("model endpoints normalize complete URLs across protocol changes without duplicate paths",()=>{
  for(const url of ["https://api.openai.com/v1/","https://api.openai.com/v1/responses","https://api.openai.com/v1/chat/completions"]){
    assert.equal(providerUrl(url,"openai_responses"),"https://api.openai.com/v1/responses");
    assert.equal(providerUrl(url,"openai_compatible_chat"),"https://api.openai.com/v1/chat/completions");
  }
  assert.equal(providerUrl("https://proxy.invalid/tenant/v1/chat/completions","openai_responses"),"https://proxy.invalid/tenant/v1/responses");
  for(const url of ["invalid","https://key@api.openai.com/v1","https://api.openai.com/v1?api_key=synthetic","http://remote.invalid/v1"])
    assert.throws(()=>providerUrl(url,"openai_responses"),{code:"INPUT_INVALID"});
});

test("real model catalog uses saved Vault credentials, returns only metadata, and never changes profiles or leaks error bodies",async t=>{
  let mode="models",requests=0;
  const key="synthetic-model-catalog-secret-only",seen:string[]=[];
  const server=createServer((req,res)=>{requests++;seen.push(req.method+" "+req.url);assert.equal(req.headers.authorization,"Bearer "+key);res.setHeader("Content-Type","application/json");
    if(mode==="models")res.end(JSON.stringify({data:[{id:"synthetic-z",created:1700000000,owned_by:"openai",shutdown_date:null},{id:"synthetic-a",created:1600000000,owned_by:"fixture",shutdown_date:"2026-01-01"}]}));
    else if(mode==="duplicate")res.end(JSON.stringify({data:[{id:"duplicate"},{id:"duplicate"}]}));
    else {res.statusCode=mode==="quota"?429:mode==="auth"?401:404;res.end(JSON.stringify({error:{code:mode==="quota"?"insufficient_quota":mode==="model"?"model_not_found":key,message:"echo "+key,param:key}}));}
  });await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo);vault.initialize("Synthetic-catalog-password-123");
  const engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine);
  t.after(async()=>{await app.close();await engine.close();db.close();server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const base="http://127.0.0.1:"+(server.address() as any).port+"/v1",profile=app.assistant.saveProfile({name:"catalog",providerKind:"openai_responses",baseUrl:base+"/chat/completions",model:"old-model",apiKey:key});
  assert.equal(profile.baseUrl,base);
  const before=JSON.stringify(repo.get("model_profiles",profile.id)),secrets=JSON.stringify(repo.all("secrets"));
  const query={serviceId:"custom",baseUrl:base+"/chat/completions",profileId:profile.id,expectedRevision:profile.revision};
  const result=await app.assistant.modelCatalog(query);assert.deepEqual(result.models.map((m:any)=>m.id),["synthetic-a","synthetic-z"]);assert.equal(result.models[0].shutdownDate,"2026-01-01");assert.equal(result.models[1].created,1700000000);assert.equal(result.endpoint,base+"/models");assert.deepEqual(seen,["GET /v1/models"]);
  assert.ok(!JSON.stringify(result).includes(key));assert.equal(JSON.stringify(repo.get("model_profiles",profile.id)),before);assert.equal(JSON.stringify(repo.all("secrets")),secrets);
  await assert.rejects(app.assistant.modelCatalog({...query,baseUrl:"https://different.invalid/v1"}),{code:"MODEL_CREDENTIAL_SCOPE_MISMATCH"});
  await assert.rejects(app.assistant.modelCatalog({...query,serviceId:"openai"}),{code:"INPUT_INVALID"});
  await assert.rejects(app.assistant.modelCatalog({...query,expectedRevision:99}),{code:"REVISION_CONFLICT"});assert.equal(requests,1);
  mode="duplicate";await assert.rejects(app.assistant.modelCatalog(query),{code:"MODEL_OUTPUT_INVALID"});
  for(const [responseMode,code] of [["model","MODEL_NOT_AVAILABLE"],["auth","MODEL_AUTH_FAILED"],["quota","MODEL_QUOTA_EXCEEDED"],["endpoint","MODEL_ENDPOINT_NOT_FOUND"]]){
    mode=responseMode!;await assert.rejects(app.assistant.modelCatalog(query),(error:any)=>{assert.equal(error.code,code);assert.ok(!JSON.stringify(error).includes(key));assert.ok(!error.message.includes(key));return true;});
  }
  mode="quota";const count=requests,provider=new HttpModelProvider(profile,key);
  await assert.rejects(provider.complete({messages:[{role:"user",content:"synthetic"}],tools:[],stream:false,signal:new AbortController().signal}),{code:"MODEL_QUOTA_EXCEEDED"});assert.equal(requests,count+1);
  assert.throws(()=>app.assistant.saveProfile({name:profile.name,providerKind:profile.providerKind,baseUrl:"https://different.invalid/v1",model:profile.model,expectedRevision:profile.revision},profile.id),{code:"MODEL_CREDENTIAL_SCOPE_MISMATCH"});
  const updated=app.assistant.saveProfile({name:profile.name,serviceId:"custom",providerKind:profile.providerKind,baseUrl:base+"/responses",model:"synthetic-z",expectedRevision:profile.revision},profile.id);assert.equal(updated.secretRef,profile.secretRef);assert.equal(JSON.stringify(repo.all("secrets")),secrets);
  vault.lock();await assert.rejects(app.assistant.modelCatalog({...query,expectedRevision:updated.revision}),{code:"CREDENTIAL_LOCKED"});
});

test("catalog rejects redirects, malformed bodies and remains bounded by AbortSignal",async t=>{
  let mode="redirect";
  const server=createServer((_req,res)=>{if(mode==="redirect"){res.writeHead(302,{Location:"https://other.invalid/models"});res.end();}else if(mode==="malformed")res.end("not-json");else{res.writeHead(200,{"Content-Type":"application/json"});res.flushHeaders();}});
  await new Promise<void>(r=>server.listen(0,"127.0.0.1",r));t.after(async()=>{server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));});
  const base="http://127.0.0.1:"+(server.address() as any).port+"/v1";
  await assert.rejects(fetchModelCatalog(base,"synthetic-key",AbortSignal.timeout(1000)));
  mode="malformed";await assert.rejects(fetchModelCatalog(base,"synthetic-key",AbortSignal.timeout(1000)),{code:"MODEL_OUTPUT_INVALID"});
  mode="stall";await assert.rejects(fetchModelCatalog(base,"synthetic-key",AbortSignal.timeout(50)));
});
