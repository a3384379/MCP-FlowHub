import type { FastifyInstance } from "fastify";
import { ensure, id, type Json } from "../../contracts/src/domain.js";
import type { AuthoringService } from "../../workflow-authoring/src/index.js";

export function registerV2(app: FastifyInstance, authoring: AuthoringService) {
  const data=(value:Json)=>({data:value,requestId:id("req")});
  const arg=(req:Json)=>({...req.body,workflowId:req.params.id});
  app.post("/api/v2/workflows",async req=>data(authoring.create(req.body)));
  app.get("/api/v2/workflows/:id/draft",async req=>data(authoring.get((req.params as Json).id)));
  app.post("/api/v2/workflows/:id/operations",async req=>{
    const a=arg(req);
    ensure(Number(req.headers["if-match"])===a.expectedRevision,"REVISION_REQUIRED","If-Match and expectedRevision must agree.",428);
    return data(authoring.patch(a));
  });
  app.post("/api/v2/workflows/:id/validate",async req=>data(authoring.validate(arg(req))));
  app.post("/api/v2/workflows/:id/publish",async req=>data(authoring.publish(arg(req))));
}
