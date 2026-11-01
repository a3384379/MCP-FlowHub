import type { FastifyInstance } from "fastify";
import { ensure, id, type Json } from "../../contracts/src/domain.js";
import type { AuthoringService } from "../../workflow-authoring/src/index.js";
import type { CapabilityRegistry } from "../../capability-registry/src/index.js";
import type { Application } from "../../application/src/index.js";

export function registerV2(app: FastifyInstance, authoring: AuthoringService, registry: CapabilityRegistry, application?:Application) {
  const data=(value:Json)=>({data:value,requestId:id("req")});
  const arg=(req:Json)=>({...req.body,workflowId:req.params.id});
  const query=(raw:Json)=>Object.fromEntries(Object.entries(raw).map(([key,value])=>{
    if(["includeSchemas","includeSkillContent"].includes(key)){ensure(value==="true"||value==="false","INPUT_INVALID","Boolean query value required.");return [key,value==="true"];}
    if(["limit","revision"].includes(key)){ensure(typeof value==="string"&&/^\d+$/.test(value),"INPUT_INVALID","Integer query value required.");return [key,Number(value)];}
    return [key,value];
  }));
  app.get("/api/v2/host-contexts",async()=>data(registry.repo.all("host_contexts").map(context=>{const last=registry.repo.db.prepare("SELECT id,json_extract(body,'$.createdAt') AS createdAt FROM discovery_jobs WHERE json_extract(body,'$.contextId')=? ORDER BY json_extract(body,'$.generation') DESC LIMIT 1").get(context.id) as Json;return {...context,lastScanId:last?.id,lastScanAt:last?.createdAt};})));
  app.post("/api/v2/host-contexts",async req=>data(await registry.context(req.body)));
  app.post("/api/v2/host-scans",async req=>data(registry.scan(req.body)));
  app.get("/api/v2/discovery/catalog",async req=>{
    const a=query(req.query);ensure(typeof a.contextId==="string","INPUT_INVALID","Context required.");
    return data({...registry.catalog.overview(a.contextId),...registry.catalog.search(a)});
  });
  app.get("/api/v2/discovery/entities/:id",async req=>{
    const entity=registry.catalog.get((req.params as Json).id);
    return data({...entity,...(entity.capabilityId?{capability:registry.get({capabilityId:entity.capabilityId,includeSchemas:true,includeSkillContent:true})}:{})});
  });
  app.post("/api/v2/discovery/descriptions",async req=>data(registry.catalog.submit(req.body as Json,"admin","manual")));
  app.get("/api/v2/capability-sources/:id/configuration",async req=>data(registry.sourceConfiguration((req.params as Json).id)));
  app.post("/api/v2/capability-sources/:id/detect",async req=>{const b=req.body as Json;ensure(b&&Number.isInteger(b.expectedRevision)&&b.expectedRevision>0,"INPUT_INVALID","Source revision required.");return data(await registry.detectSource((req.params as Json).id,b.expectedRevision));});
  app.post("/api/v2/capability-sources/:id/credentials",async req=>data(await registry.configureSource({...req.body as Json,sourceId:(req.params as Json).id})));
  app.get("/api/v2/host-scans/:id",async req=>data(registry.status((req.params as Json).id)));
  app.post("/api/v2/host-scans/:id/cancel",async req=>data(registry.cancel((req.params as Json).id)));
  app.get("/api/v2/capabilities",async req=>data(registry.search(query(req.query))));
  app.get("/api/v2/capabilities/:id",async req=>data(registry.get({...query(req.query),capabilityId:(req.params as Json).id})));
  app.post("/api/v2/capabilities/:id/import",async req=>data(await registry.import({...req.body as Json,capabilityId:(req.params as Json).id})));
  app.post("/api/v2/workflows",async req=>data(authoring.create(req.body)));
  app.get("/api/v2/workflows/:id/draft",async req=>data(authoring.get((req.params as Json).id)));
  app.post("/api/v2/workflows/:id/operations",async req=>{
    const a=arg(req);
    ensure(Number(req.headers["if-match"])===a.expectedRevision,"REVISION_REQUIRED","If-Match and expectedRevision must agree.",428);
    return data(authoring.patch(a));
  });
  app.post("/api/v2/workflows/:id/validate",async req=>data(authoring.validate(arg(req))));
  app.post("/api/v2/workflows/:id/publish",async req=>data(authoring.publish(arg(req))));
  app.post("/api/v2/workflows/:id/undo",async req=>data(authoring.undo(arg(req))));
  if(application) {
    app.get("/api/v2/model-docs",async req=>data(await application.assistant.modelDocumentation(req.query)));
    app.post("/api/v2/model-catalog",async req=>data(await application.assistant.modelCatalog(req.body)));
    app.get("/api/v2/model-profiles",async()=>data(application.assistant.profiles()));
    app.post("/api/v2/model-profiles",async req=>data(application.assistant.saveProfile(req.body)));
    app.patch("/api/v2/model-profiles/:id",async req=>data(application.assistant.saveProfile(req.body,(req.params as Json).id)));
    app.delete("/api/v2/model-profiles/:id",async req=>data(application.assistant.deleteProfile((req.params as Json).id)));
    app.post("/api/v2/model-profiles/:id/test",async req=>data(await application.assistant.testProfile((req.params as Json).id)));
    app.get("/api/v2/assistant/sessions",async()=>data(application.assistant.sessions()));
    app.post("/api/v2/assistant/sessions",async()=>data(application.assistant.session()));
    app.delete("/api/v2/assistant/sessions/:id",async req=>data(application.assistant.deleteSession((req.params as Json).id)));
    app.get("/api/v2/assistant/sessions/:id/messages",async req=>data(application.assistant.messagePage((req.params as Json).id,req.query)));
    app.get("/api/v2/assistant/sessions/:id/conversation",async req=>data(application.assistant.conversationPage((req.params as Json).id,req.query)));
    app.get("/api/v2/assistant/sessions/:id/tasks",async req=>{
      const sessionId=(req.params as Json).id;application.assistant.messages(sessionId);
      return data(registry.repo.all("assistant_tasks").filter(t=>t.sessionId===sessionId).map(t=>application.assistant.task(t.id)));
    });
    app.post("/api/v2/assistant/sessions/:id/messages",async req=>data(application.assistant.submit((req.params as Json).id,req.body)));
    app.get("/api/v2/assistant/tasks/:id",async req=>data(application.assistant.task((req.params as Json).id)));
    app.post("/api/v2/assistant/tasks/:id/cancel",async req=>data(application.assistant.cancel((req.params as Json).id)));
    app.post("/api/v2/runs/:id/analysis",async req=>{
      const body=req.body as Json;ensure(typeof body.modelProfileId==="string"&&typeof body.idempotencyKey==="string","INPUT_INVALID","Model profile and idempotency key required.");
      return data(application.assistant.analyzeCheckpoint((req.params as Json).id,body.modelProfileId,body.idempotencyKey));
    });
    app.post("/api/v2/workflows/:id/test-suites",async req=>data(application.testing.generate(arg(req))));
    app.get("/api/v2/workflows/:id/test-suites",async req=>{
      authoring.get((req.params as Json).id);
      return data(registry.repo.all("workflow_test_suites").filter(s=>s.workflowId===(req.params as Json).id).map(({cases,...s}:Json)=>s));
    });
    app.get("/api/v2/test-suites/:id",async req=>data(application.testing.getSuite((req.params as Json).id)));
    app.put("/api/v2/test-suites/:id",async req=>{
      const body=req.body as Json,suite=application.testing.getSuite((req.params as Json).id);
      return data(application.testing.generate({workflowId:suite.workflowId,expectedRevision:body.expectedRevision,
        strategy:"agent_proposed",proposedCases:body.cases,baseSuiteId:suite.id,expectedSuiteRevision:body.expectedSuiteRevision,idempotencyKey:body.idempotencyKey}));
    });
    app.post("/api/v2/test-suites/:id/runs",async req=>data(application.testing.run({...req.body as Json,suiteId:(req.params as Json).id})));
    app.get("/api/v2/test-runs/:id",async req=>data(application.testing.status((req.params as Json).id)));
    app.get("/api/v2/help/source",async req=>{const source=application.knowledge.source(req.query);ensure(source,"NOT_FOUND","Knowledge source missing.",404);return data(source);});
    app.get("/api/v2/help/search",async req=>data(application.knowledge.search(req.query)));
  }
}
