import { hash } from "../../contracts/src/domain.js";
export const V2_TABLES = ["host_contexts", "discovery_jobs", "capability_sources", "capabilities", "capability_revisions", "authoring_commands", "workflow_test_suites", "workflow_test_runs", "model_profiles", "assistant_sessions", "assistant_messages", "assistant_tasks", "assistant_tool_calls", "knowledge_documents", "knowledge_chunks"] as const;
const ddl = V2_TABLES.map(t => "CREATE TABLE " + t + " (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, body TEXT NOT NULL)").join(";") + ";" +
  "CREATE TABLE application_events(event_id INTEGER PRIMARY KEY AUTOINCREMENT, body TEXT NOT NULL);" +
  "CREATE VIRTUAL TABLE knowledge_fts USING fts5(chunk_id UNINDEXED, tokens);" +
  "CREATE INDEX capabilities_context ON capabilities(json_extract(body,'$.contextId'),json_extract(body,'$.kind'),json_extract(body,'$.executor'));" +
  "CREATE UNIQUE INDEX capability_source_identity ON capability_sources(json_extract(body,'$.contextId'),json_extract(body,'$.sourceKey'));" +
  "CREATE UNIQUE INDEX capability_revision_identity ON capability_revisions(json_extract(body,'$.capabilityId'),json_extract(body,'$.capabilityRevision'));" +
  "CREATE INDEX discovery_context ON discovery_jobs(json_extract(body,'$.contextId'),json_extract(body,'$.createdAt'));" +
  "CREATE INDEX assistant_task_status ON assistant_tasks(json_extract(body,'$.sessionId'),json_extract(body,'$.status'));" +
  "CREATE UNIQUE INDEX assistant_call_identity ON assistant_tool_calls(json_extract(body,'$.taskId'),json_extract(body,'$.callId'));" +
  "CREATE UNIQUE INDEX authoring_identity ON authoring_commands(json_extract(body,'$.owner'),json_extract(body,'$.operation'),json_extract(body,'$.idempotencyKey'));" +
  "CREATE INDEX suite_workflow ON workflow_test_suites(json_extract(body,'$.workflowId'),json_extract(body,'$.draftRevision'));" +
  "CREATE INDEX test_suite_run ON workflow_test_runs(json_extract(body,'$.suiteId'),json_extract(body,'$.createdAt'));" +
  "CREATE UNIQUE INDEX knowledge_chunk_identity ON knowledge_chunks(json_extract(body,'$.documentId'),json_extract(body,'$.chunkIndex'))";
export const V2_MIGRATION = {version:2, ddl, checksum:hash(ddl), tables:[...V2_TABLES,"application_events","knowledge_fts"]};
