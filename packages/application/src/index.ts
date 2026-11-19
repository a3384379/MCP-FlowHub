import { EXECUTION_TOOL_NAMES, validArguments, type ToolName } from "../../contracts/src/index.js";
import { ensure, type Json } from "../../contracts/src/domain.js";
import type { Engine } from "../../workflow-core/src/engine.js";
import { AuthoringService } from "../../workflow-authoring/src/index.js";
import { CapabilityRegistry } from "../../capability-registry/src/index.js";
import { WorkflowTesting } from "../../workflow-testing/src/index.js";
import { ProjectKnowledge } from "../../project-knowledge/src/index.js";
import { AssistantCore } from "../../assistant-core/src/index.js";
import type {DiscoveryRuntime} from "../../host-discovery/src/index.js";
import type { ProviderFactory } from "../../llm-providers/src/index.js";

export class Application {
  readonly authoring:AuthoringService;
  readonly registry:CapabilityRegistry;
  readonly testing:WorkflowTesting;
  readonly knowledge:ProjectKnowledge;
  readonly assistant:AssistantCore;
  constructor(readonly engine:Engine,options:{providerFactory?:ProviderFactory;hostDiscoveryRuntime?:DiscoveryRuntime}={}) {
    this.authoring=new AuthoringService(engine,(workflowId,revision)=>this.testing.publicationEvidence(workflowId,revision));this.registry=new CapabilityRegistry(engine,options.hostDiscoveryRuntime?{hostRuntime:options.hostDiscoveryRuntime}:{});this.testing=new WorkflowTesting(this.authoring);this.knowledge=new ProjectKnowledge(engine.repo);
    this.assistant=new AssistantCore(this,options.providerFactory);
    this.testing.configureAi((request,signal,owner)=>this.assistant.proposeTestCases(request,signal,owner));
  }
  async handle(name:ToolName,args:Json,owner="execution"):Promise<Json> {
    ensure(validArguments(name,args),"INPUT_INVALID","Arguments do not match the fixed tool contract.");
    if((EXECUTION_TOOL_NAMES as readonly string[]).includes(name))return this.engine.handle(name,args,owner);
    this.authoring.authorize(owner);
    switch(name) {
      case "host_scan":return this.registry.scan(args,owner);
      case "host_scan_status":return this.registry.status(String(args.scanId),owner);
      case "capability_search":return this.registry.search(args);
      case "capability_get":return this.registry.get(args);
      case "capability_import":return this.registry.import(args,owner);
      case "workflow_draft_get":return this.authoring.get(String(args.workflowId),owner);
      case "workflow_draft_create":return this.authoring.create(args,owner);
      case "workflow_draft_patch":return this.authoring.patch(args,owner);
      case "workflow_draft_validate":return this.authoring.validate(args,owner);
      case "workflow_draft_publish":return this.authoring.publish(args,owner);
      case "workflow_test_generate":return this.testing.generate(args,owner);
      case "workflow_test_run":return this.testing.run(args,owner);
      case "workflow_test_status":return this.testing.status(String(args.testRunId),owner);
      case "project_help_search":return this.knowledge.search(args);
      default:throw new Error("Unknown fixed tool.");
    }
  }
  async close(){const results=await Promise.allSettled([this.assistant.close(),this.registry.close(),this.testing.close()]);const failed=results.find(result=>result.status==="rejected");if(failed?.status==="rejected")throw failed.reason;}
}
