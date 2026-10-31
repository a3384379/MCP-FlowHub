import type { FastifyInstance } from "fastify";
import { ensure, id, type Json } from "../../contracts/src/domain.js";
import type { AuthoringService } from "../../workflow-authoring/src/index.js";
import type { CapabilityRegistry } from "../../capability-registry/src/index.js";
import type { Application } from "../../application/src/index.js";

export function registerV2(app: FastifyInstance, authoring: AuthoringService, registry: CapabilityRegistry, application?:Application) {
  const data=(value:Json)=>({data:value,requestId:id("req")});
  const arg=(req:Json)=>({...req.body,workflowId:req.params.id});
  app.get("/api/v2/host-contexts",async()=>data(registry.repo.all("host_contexts")));
  app.post("/api/v2/host-contexts",async req=>data(await registry.context(req.body)));
  app.post("/api/v2/host-scans",async req=>data(registry.scan(req.body)));
  app.post("/api/v2/capability-sources/:id/credentials",async req=>data(await registry.configureSource({...req.body as Json,sourceId:(req.params as Json).id})));
  app.get("/api/v2/host-scans/:id",async req=>data(registry.status((req.params as Json).id)));
  app.get("/api/v2/capabilities",async req=>data(registry.search(req.query)));
  app.get("/api/v2/capabilities/:id",async req=>data(registry.get({...req.query as Json,capabilityId:(req.params as Json).id})));
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
    app.get("/api/v2/model-profiles",async()=>data(application.assistant.profiles()));
    app.post("/api/v2/model-profiles",async req=>data(application.assistant.saveProfile(req.body)));
    app.patch("/api/v2/model-profiles/:id",async req=>data(application.assistant.saveProfile(req.body,(req.params as Json).id)));
    app.delete("/api/v2/model-profiles/:id",async req=>data(application.assistant.deleteProfile((req.params as Json).id)));
    app.post("/api/v2/model-profiles/:id/test",async req=>data(await application.assistant.testProfile((req.params as Json).id)));
    app.get("/api/v2/assistant/sessions",async()=>data(application.assistant.sessions()));
    app.post("/api/v2/assistant/sessions",async()=>data(application.assistant.session()));
    app.delete("/api/v2/assistant/sessions/:id",async req=>data(application.assistant.deleteSession((req.params as Json).id)));
    app.get("/api/v2/assistant/sessions/:id/messages",async req=>data(application.assistant.messages((req.params as Json).id)));
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
    app.get("/api/v2/help/search",async req=>data(application.knowledge.search(req.query)));
  }
}
