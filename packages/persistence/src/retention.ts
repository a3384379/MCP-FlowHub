import { ensure, hash, type Json } from "../../contracts/src/domain.js";
import type { Repository } from "./repository.js";

const day = 86400000;
const terminal = new Set([
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "REJECTED",
  "OUTCOME_UNKNOWN",
]);
const taskTerminal = new Set(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const testTerminal = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "PARTIAL", "INTERRUPTED"]);
const recordTime = (record: Json) => Math.max(...["createdAt", "updatedAt", "completedAt", "finishedAt"].map(key => {
  const value=Date.parse(record?.[key]);return Number.isFinite(value)?value:0;
}));
const metadata = (record: Json, keys: string[], timestamp: string) => ({
  ...Object.fromEntries(keys.filter(key => Object.hasOwn(record,key)).map(key => [key,record[key]])),
  resultsExpiredAt: timestamp,
});

/** Conversation/test results follow the same seven-day payload and thirty-day
 * metadata policy. Saved suites and immutable capability/version snapshots are
 * configuration, so none of those tables is selected by this cleanup. */
function previewV2(repo: Repository, at: number, expiredRuns: Set<string>) {
  const tasks=repo.all("assistant_tasks"),messages=repo.all("assistant_messages"),calls=repo.all("assistant_tool_calls"),sessions=repo.all("assistant_sessions"),tests=repo.all("workflow_test_runs");
  const taskById=new Map(tasks.map(task => [task.id,task]));
  const activeTasks=new Set(tasks.filter(task => !taskTerminal.has(task.status)).map(task => task.id));
  const activeSessions=new Set(tasks.filter(task => activeTasks.has(task.id)).map(task => task.sessionId));
  const inactive=(record:Json) => !activeSessions.has(record.sessionId)&&!activeTasks.has(record.taskId??record.id);
  const older=(record:Json,days:number) => recordTime(record)>0&&recordTime(record)<at-days*day;
  const assistantTasks=tasks.filter(task => inactive(task)&&older(task,30)).map(task => task.id as string);
  const deletedTasks=new Set(assistantTasks);
  const assistantResultTasks=tasks.filter(task => inactive(task)&&!deletedTasks.has(task.id)&&!task.resultsExpiredAt&&
    (older(task,7)||expiredRuns.has(task.context?.runId))).map(task => task.id as string);
  const resultTasks=new Set([...assistantResultTasks,...tasks.filter(task=>task.resultsExpiredAt).map(task=>task.id)]);
  const latestSession=(session:Json) => Math.max(recordTime(session),...tasks.filter(task=>task.sessionId===session.id).map(recordTime),...messages.filter(message=>message.sessionId===session.id).map(recordTime));
  const assistantSessions=sessions.filter(session=>!activeSessions.has(session.id)&&latestSession(session)>0&&latestSession(session)<at-30*day).map(session=>session.id as string);
  const deletedSessions=new Set(assistantSessions);
  const assistantResultSessions=sessions.filter(session=>!activeSessions.has(session.id)&&!deletedSessions.has(session.id)&&!session.resultsExpiredAt&&latestSession(session)>0&&latestSession(session)<at-7*day).map(session=>session.id as string);
  const assistantMessages=messages.filter(message=>inactive(message)&&(deletedTasks.has(message.taskId)||deletedSessions.has(message.sessionId)||older(message,30))).map(message=>message.id as string);
  const deletedMessages=new Set(assistantMessages);
  // Delivered legacy messages have no task identity, so a fresh timestamp does
  // not prove their text is independent of expired results in the same session.
  // Expose this conservative scope separately; never guess or rewrite content.
  const expiredSourceSessions=new Set(tasks.filter(task=>resultTasks.has(task.id)||deletedTasks.has(task.id)).map(task=>task.sessionId));
  const assistantLegacyResultMessages=messages.filter(message=>inactive(message)&&!deletedMessages.has(message.id)&&!message.resultsExpiredAt&&!message.taskId&&expiredSourceSessions.has(message.sessionId)).map(message=>message.id as string);
  const legacyMessages=new Set(assistantLegacyResultMessages);
  const assistantResultMessages=messages.filter(message=>inactive(message)&&!deletedMessages.has(message.id)&&!legacyMessages.has(message.id)&&!message.resultsExpiredAt&&
    (resultTasks.has(message.taskId)||older(message,7))).map(message=>message.id as string);
  const assistantToolCalls=calls.filter(call=>inactive(call)&&(deletedTasks.has(call.taskId)||deletedSessions.has(call.sessionId)||older(call,30))).map(call=>call.id as string);
  const deletedCalls=new Set(assistantToolCalls);
  const assistantResultToolCalls=calls.filter(call=>inactive(call)&&!deletedCalls.has(call.id)&&!call.resultsExpiredAt&&
    (resultTasks.has(call.taskId)||older(call,7)||older(taskById.get(call.taskId),7))).map(call=>call.id as string);
  const workflowTestRuns=tests.filter(test=>testTerminal.has(test.status)&&older(test,30)).map(test=>test.id as string);
  const deletedTests=new Set(workflowTestRuns);
  const workflowTestResultRuns=tests.filter(test=>testTerminal.has(test.status)&&!deletedTests.has(test.id)&&!test.resultsExpiredAt&&older(test,7)).map(test=>test.id as string);
  const expiredTests=new Set([...workflowTestResultRuns,...tests.filter(test=>test.resultsExpiredAt).map(test=>test.id)]);
  const activeTests=new Set(tests.filter(test=>!testTerminal.has(test.status)).map(test=>test.id));
  const activeRuns=new Set(repo.all("runs").filter(run=>!terminal.has(run.state)).map(run=>run.id));
  const events=repo.db.prepare("SELECT event_id,body FROM application_events ORDER BY event_id").all() as {event_id:number;body:string}[];
  const applicationEvents:number[]=[],applicationResultEvents:number[]=[];
  for(const event of events) {
    const body=JSON.parse(event.body),taskId=body.taskId??body.data?.taskId,sessionId=body.sessionId??taskById.get(taskId)?.sessionId,
      runId=body.runId??body.data?.runId??body.data?.result?.runId,testId=body.testRunId??body.data?.testRunId;
    if(activeTasks.has(taskId)||activeSessions.has(sessionId)||activeRuns.has(runId)||activeTests.has(testId))continue;
    const time=Date.parse(body.timestamp??body.createdAt),old=Number.isFinite(time);
    if(deletedTasks.has(taskId)||deletedSessions.has(sessionId)||deletedTests.has(testId)||(old&&time<at-30*day))applicationEvents.push(event.event_id);
    else if(!body.resultsExpiredAt&&(resultTasks.has(taskId)||expiredRuns.has(runId)||expiredTests.has(testId)||(old&&time<at-7*day)))applicationResultEvents.push(event.event_id);
  }
  const scope={assistantSessions,assistantResultSessions,assistantTasks,assistantResultTasks,assistantMessages,assistantResultMessages,assistantLegacyResultMessages,assistantToolCalls,assistantResultToolCalls,workflowTestRuns,workflowTestResultRuns,applicationEvents,applicationResultEvents};
  const selected=(records:Json[],ids:string[])=>records.filter(record=>ids.includes(record.id));
  return {scope,records:{sessions:selected(sessions,[...assistantSessions,...assistantResultSessions]),tasks:selected(tasks,[...assistantTasks,...assistantResultTasks]),messages:selected(messages,[...assistantMessages,...assistantResultMessages,...assistantLegacyResultMessages]),calls:selected(calls,[...assistantToolCalls,...assistantResultToolCalls]),tests:selected(tests,[...workflowTestRuns,...workflowTestResultRuns]),events:events.filter(event=>applicationEvents.includes(event.event_id)||applicationResultEvents.includes(event.event_id))}};
}

export function previewRetention(repo: Repository, at = Date.now()) {
  const records = repo.all("runs");
  const artifacts = repo.all("artifacts");
  const eligible = records.filter((run) => terminal.has(run.state));
  const runs = eligible
    .filter((run) => Date.parse(run.updatedAt) < at - 30 * day)
    .map((run) => run.id as string);
  const deleted = new Set(runs);
  const expiredArtifacts = new Set(
    artifacts
      .filter((artifact) => artifact.expiresAt <= at)
      .map((artifact) => artifact.runId),
  );
  const resultRuns = eligible
    .filter(
      (run) =>
        !deleted.has(run.id) &&
        (expiredArtifacts.has(run.id) ||
          (Date.parse(run.updatedAt) < at - 7 * day && !run.resultsExpiredAt)),
    )
    .map((run) => run.id as string);
  const expired = new Set(resultRuns);
  const checkpoints = eligible
    .filter((run) => !deleted.has(run.id) && !!run.checkpoint)
    .map((run) => run.id as string);
  const artifactIds = artifacts
    .filter(
      (artifact) => deleted.has(artifact.runId) || expired.has(artifact.runId),
    )
    .map((artifact) => artifact.id as string);
  const changed = new Set([...runs, ...resultRuns, ...checkpoints]);
  const scope = { runs, resultRuns, checkpoints, artifacts: artifactIds };
  const v2=previewV2(repo,at,new Set([...runs,...resultRuns,...records.filter(run=>run.resultsExpiredAt).map(run=>run.id)]));
  // Bind confirmation to the selected records as well as IDs. A terminal run
  // changing after preview must not silently reuse a stale cleanup decision.
  const digest = hash({
    scope,
    v2,
    records: records.filter((run) => changed.has(run.id)),
    artifacts: artifacts.filter((artifact) =>
      artifactIds.includes(artifact.id),
    ),
    approvals: repo
      .all("approvals")
      .filter((approval) => changed.has(approval.runId)),
    events: [...changed].map((runId) =>
      repo.db
        .prepare("SELECT body FROM run_events WHERE run_id=? ORDER BY seq")
        .all(runId),
    ),
  });
  return { ...scope, ...v2.scope, hash: digest };
}

export function commitRetention(
  repo: Repository,
  previewHash: unknown,
  at = Date.now(),
) {
  // Remove freed payload bytes from current SQLite pages too, so a new backup
  // cannot retain them in unused cells/overflow pages. Existing backups and WAL
  // history have their own lifecycle; this is not a secure-erase guarantee.
  repo.db.pragma("secure_delete = ON");
  return repo.tx(() => {
    const preview = previewRetention(repo, at);
    ensure(
      preview.hash === previewHash,
      "REVISION_CONFLICT",
      "Cleanup scope changed.",
      409,
    );
    const timestamp = new Date(at).toISOString();
    for (const artifactId of preview.artifacts)
      repo.remove("artifacts", artifactId);
    for (const runId of preview.resultRuns) {
      const run = repo.get("runs", runId);
      run.outputs = {};
      delete run.operationalOutputs;
      delete run.checkpoint;
      run.resultsExpiredAt = timestamp;
      run.revision++;
      // Preserve updatedAt: maintenance must not extend metadata retention.
      repo.put("runs", runId, run);
      for (const approval of repo
        .all("approvals")
        .filter((item) => item.runId === runId)) {
        delete approval.arguments;
        approval.resultsExpiredAt = timestamp;
        repo.put("approvals", approval.id, approval);
      }
      const events = repo.db
        .prepare("SELECT seq,body FROM run_events WHERE run_id=?")
        .all(runId) as { seq: number; body: string }[];
      for (const event of events) {
        const body = JSON.parse(event.body) as Json;
        if (Object.hasOwn(body, "reason")) {
          delete body.reason;
          repo.db
            .prepare("UPDATE run_events SET body=? WHERE run_id=? AND seq=?")
            .run(JSON.stringify(body), runId, event.seq);
        }
      }
    }
    for (const runId of preview.checkpoints) {
      const run = repo.get("runs", runId);
      if (!run.checkpoint) continue;
      delete run.checkpoint;
      run.revision++;
      repo.put("runs", runId, run);
    }
    for (const runId of preview.runs) {
      for (const table of ["attempts", "approvals"] as const)
        for (const item of repo
          .all(table)
          .filter((item) => item.runId === runId))
          repo.remove(table, item.id);
      repo.db.prepare("DELETE FROM run_events WHERE run_id=?").run(runId);
      // Commands store request hashes and small run summaries, not payloads.
      repo.db
        .prepare(
          "DELETE FROM commands WHERE json_extract(response,'$.runId')=?",
        )
        .run(runId);
      repo.remove("runs", runId);
    }
    // Keep command request hashes/responses as small tombstones: an expired
    // assistant task must never be recreated by replaying its idempotency key.
    const expire=(table:"assistant_sessions"|"assistant_tasks"|"assistant_messages"|"assistant_tool_calls"|"workflow_test_runs",ids:string[],keys:string[])=>{
      for(const id of ids) {
        const record=repo.get(table,id);
        repo.put(table,id,metadata(record,keys,timestamp));
      }
    };
    const common=["id","revision","owner","createdAt","updatedAt","completedAt","finishedAt","status","errorCode"];
    expire("assistant_sessions",preview.assistantResultSessions,[...common]);
    expire("assistant_tasks",preview.assistantResultTasks,[...common,"sessionId","modelProfileId","mode","rounds","toolCalls","usage"]);
    expire("assistant_messages",[...preview.assistantResultMessages,...preview.assistantLegacyResultMessages],[...common,"sessionId","taskId","role"]);
    expire("assistant_tool_calls",preview.assistantResultToolCalls,[...common,"sessionId","taskId","callId","name","argumentsHash","requestHash"]);
    expire("workflow_test_runs",preview.workflowTestResultRuns,[...common,"kind","mode","validationLevel","verificationLevel","provenance","suiteId","workflowId","draftRevision","suiteRevision","fixtureHash","capabilityRevisions","snapshotHash","summary","simulationOnly","networkCalls","realSecretReads",
      "modelProfileId","requestHash","modelCalls","usage","usageAccounting","businessServiceCalls","caseCount","toolCalls","catalogChecks","credentialReadAccounting","scopeHash"]);
    for(const [table,ids] of [["assistant_sessions",preview.assistantSessions],["assistant_tasks",preview.assistantTasks],["assistant_messages",preview.assistantMessages],["assistant_tool_calls",preview.assistantToolCalls],["workflow_test_runs",preview.workflowTestRuns]] as const)
      for(const id of ids)repo.remove(table,id);
    for(const eventId of preview.applicationResultEvents) {
      const row=repo.db.prepare("SELECT body FROM application_events WHERE event_id=?").get(eventId) as {body:string};
      const body=metadata(JSON.parse(row.body),["type","timestamp","createdAt","taskId","sessionId","testRunId","workflowId","runId","revision","layoutRevision","caseId","status","code"],timestamp);
      repo.db.prepare("UPDATE application_events SET body=? WHERE event_id=?").run(JSON.stringify(body),eventId);
    }
    for(const eventId of preview.applicationEvents)repo.db.prepare("DELETE FROM application_events WHERE event_id=?").run(eventId);
    repo.audit("admin", "retention:cleanup", String(preview.runs.length));
    return {
      deletedRuns: preview.runs.length,
      deletedArtifacts: preview.artifacts.length,
      expiredResultRuns: preview.resultRuns.length,
      clearedCheckpoints: preview.checkpoints.length,
      expiredAssistantTasks:preview.assistantResultTasks.length,
      deletedAssistantTasks:preview.assistantTasks.length,
      expiredAssistantMessages:preview.assistantResultMessages.length+preview.assistantLegacyResultMessages.length,
      expiredLegacyAssistantMessages:preview.assistantLegacyResultMessages.length,
      deletedAssistantMessages:preview.assistantMessages.length,
      expiredAssistantToolCalls:preview.assistantResultToolCalls.length,
      deletedAssistantToolCalls:preview.assistantToolCalls.length,
      expiredAssistantSessions:preview.assistantResultSessions.length,
      deletedAssistantSessions:preview.assistantSessions.length,
      expiredTestRuns:preview.workflowTestResultRuns.length,
      deletedTestRuns:preview.workflowTestRuns.length,
      expiredApplicationEvents:preview.applicationResultEvents.length,
      deletedApplicationEvents:preview.applicationEvents.length,
    };
  });
}
