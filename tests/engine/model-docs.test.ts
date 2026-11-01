import {test} from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {fetchOfficialModelDoc,parseOfficialModelDoc} from "../../packages/llm-providers/src/model-docs.js";
import {Repository} from "../../packages/persistence/src/repository.js";
import {Vault} from "../../packages/security/src/index.js";
import {Connectors} from "../../packages/mcp-connectors/src/registry.js";
import {Engine} from "../../packages/workflow-core/src/engine.js";
import {Application} from "../../packages/application/src/index.js";

const markdown='Model ID: `fixture-public-model`\n- 123,456 context window\n- Maximum input tokens: 120,000\n- 3,456 max output tokens\n`reasoning.effort` supports `none`, `high`.\nChat Completions supports function calling only with `reasoning_effort` set to `none`.\n';
test("model parameters require the exact official model page and absent fields stay unknown",()=>{
  const result=parseOfficialModelDoc("fixture-public-model",markdown);
  assert.equal(result.contextWindow,123456);assert.equal(result.maxInputTokens,120000);assert.equal(result.maxOutputTokens,3456);assert.deepEqual(result.reasoningEfforts,["none","high"]);assert.equal(result.chatToolsReasoningEffort,"none");assert.match(result.contentHash,/^[a-f0-9]{64}$/);
  assert.equal(parseOfficialModelDoc("other",markdown).status,"unavailable");
  const unknown=parseOfficialModelDoc("fixture-public-model","Model ID: `fixture-public-model`");assert.equal(unknown.contextWindow,null);assert.deepEqual(unknown.reasoningEfforts,[]);
});

test("public model documentation has a fixed official origin, no authentication, byte limits, caching and shutdown cancellation",async t=>{
  const original=globalThis.fetch;let calls=0,mode="valid";
  globalThis.fetch=async(url,options)=>{
    calls++;assert.equal(String(url),"https://developers.openai.com/api/docs/models/fixture-public-model.md");assert.deepEqual(options?.headers,{Accept:"text/markdown"});assert.equal(options?.redirect,"error");
    if(mode==="stall")return new Promise((_resolve,reject)=>{options?.signal?.addEventListener("abort",()=>reject(new Error("stopped")),{once:true});});
    return new Response(mode==="oversized"?"x".repeat(262145):markdown,{status:mode==="missing"?404:200});
  };
  const db=new Database(":memory:"),repo=new Repository(db),vault=new Vault(repo),engine=new Engine(repo,vault,new Connectors(repo,vault)),app=new Application(engine);
  t.after(async()=>{globalThis.fetch=original;await app.close();await engine.close();db.close();});
  const params=await app.assistant.modelDocumentation({model:"fixture-public-model"});assert.equal(params.contextWindow,123456);assert.equal(params.sourceUrl,"https://developers.openai.com/api/docs/models/fixture-public-model");
  assert.deepEqual(await app.assistant.modelDocumentation({model:"fixture-public-model"}),params);assert.equal(calls,1);
  await assert.rejects(app.assistant.modelDocumentation({model:"../credentials"}),{code:"INPUT_INVALID"});assert.equal(calls,1);
  mode="missing";assert.equal((await fetchOfficialModelDoc("fixture-public-model",AbortSignal.timeout(1000))).status,"unavailable");
  mode="oversized";await assert.rejects(fetchOfficialModelDoc("fixture-public-model",AbortSignal.timeout(1000)),{code:"BUDGET_EXCEEDED"});
  // Clear the internal cache through a new service instance; no persisted data is touched.
  const fresh=new Application(engine);mode="stall";const pending=fresh.assistant.modelDocumentation({model:"fixture-public-model"});const rejected=assert.rejects(pending,{code:"SERVICE_STOPPING"});await fresh.close();await rejected;
});
