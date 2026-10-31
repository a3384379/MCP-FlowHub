import { ensure, type Json } from "../../contracts/src/domain.js";

export const CONTEXT_BYTE_LIMIT = 64000;
const bytes = (value: Json) => Buffer.byteLength(JSON.stringify(value), "utf8");

/** Byte ranges are measured on the original UTF-8 text, never on JS code units. */
export function utf8Prefix(text: string, limit: number) {
  const raw = Buffer.from(text, "utf8");
  let end = Math.min(raw.length, Math.max(0, limit));
  while (end > 0 && end < raw.length && (raw[end]! & 0xc0) === 0x80) end--;
  return { content: raw.subarray(0, end).toString("utf8"), offset: 0, nextOffset: end, totalBytes: raw.length, truncated: end < raw.length };
}
// JSON escaping can expand control characters by six bytes; bound the encoded
// string as well as its original UTF-8 prefix.
function encodedPrefix(text: string, limit: number) {
  let low=0,high=Math.min(Buffer.byteLength(text),limit),best=utf8Prefix(text,0);
  while(low<=high){const mid=Math.floor((low+high)/2),candidate=utf8Prefix(text,mid);
    if(bytes(candidate.content)<=limit){best=candidate;low=mid+1;}else high=mid-1;
  }
  return best;
}

function workflowMinimum(value: Json, selected: string[]) {
  const draft = value.draft ?? {}, wanted = new Set([...selected, "input", "end"]);
  const retrieve=value.source==="selected_run_snapshot"?"workflow_get(workflowId, version)":"workflow_draft_get(workflowId)";
  return {
    workflowId: value.workflowId ?? draft.workflowId, revision: value.revision, layoutRevision: value.layoutRevision,
    ...(value.version?{version:value.version}:{}),...(value.source?{source:value.source}:{}),
    draft: {
      schemaVersion: draft.schemaVersion, workflowId: draft.workflowId, name: draft.name,
      environment: draft.environment, mode: draft.mode, version: draft.version,
      nodes: (draft.nodes ?? []).filter((node: Json) => wanted.has(node.id)).map((node: Json) => ({
        id: node.id, type: node.type, title: encodedPrefix(node.title??"",100).content,
        ...(bytes(node.title??"")>100?{titleTruncated:true}:{}),
        config: { omitted: true, totalBytes: bytes(node.config ?? {}) },
      })),
      nodeCount: draft.nodes?.length ?? 0, edgeCount: draft.edges?.length ?? 0,
    },
    definitionTruncated: true, retrieve: retrieve+" returns the complete definition and schemas.",
  };
}
function runMinimum(value: Json) {
  return {
    runId: value.runId, workflowId: value.workflowId, version: value.version, revision: value.revision,
    environment: value.environment, state: value.state, currentNode: value.currentNode,
    checkpoint: value.checkpoint ? { id: value.checkpoint.id, nodeId: value.checkpoint.nodeId, kind: value.checkpoint.kind } : null,
    retrieve: "workflow_status(runId); artifact_read(runId, artifactId, offset, maxBytes)",
  };
}
function previousMinimum(values: Json[]) {
  return values.map(value => {const {content, ...range}=encodedPrefix(value.partialText ?? "", 6000);return ({
    taskId: value.taskId, status: value.status, errorCode: value.errorCode,
    partialText: content, partialTextRange: range,
    tools: (value.tools ?? []).map((tool: Json) => ({
      name: tool.name, status: tool.status, isError: tool.isError, receiptRef: tool.receiptRef,
      resultBytes: bytes(tool.result ?? null), resultOmitted: true,
    })),
  });});
}

/** Preserve a structured directory page, with exact omitted item counts at each path. */
function directoryWithin(value: Json, limit: number) {
  const result = structuredClone(value), omitted = new Map<string, Json>();
  while (bytes(result) > limit) {
    const arrays: { path: string; value: Json[]; size: number }[] = [];
    const visit = (item: Json, path: string) => {
      if (Array.isArray(item)) {
        if (item.length) arrays.push({ path, value: item, size: bytes(item) });
        item.forEach((child, i) => visit(child, path + "/" + i));
      } else if (item && typeof item === "object") for (const [key, child] of Object.entries(item)) visit(child, path + "/" + key);
    };
    visit(result, "");
    const largest = arrays.sort((a, b) => b.size - a.size)[0];
    if (!largest) return null;
    const count = largest.value.length, remaining = Math.floor(count / 2);
    const prior = omitted.get(largest.path);
    omitted.set(largest.path, { path: largest.path, totalItems: prior?.totalItems ?? count, includedItems: remaining });
    largest.value.splice(remaining);
  }
  return { value: result, omitted: [...omitted.values()] };
}

/**
 * Selected objects are seeded before any directory/help data. Each optional
 * source also has its own cap; a large catalog cannot displace those seeds.
 */
export function budgetContext(source: Json) {
  const totalBytes = bytes(source), result: Json = {
    selectedNodeIds: source.selectedNodeIds ?? [],
    selection: source.selection ?? {},
  };
  const specs: { key: string; cap: number; minimum: Json; retrieve: string }[] = [];
  const add = (key: string, cap: number, minimum: Json, retrieve: string) => {
    if (source[key] === undefined) return;
    result[key] = minimum; specs.push({ key, cap, minimum, retrieve });
  };
  add("workflow", 38000, workflowMinimum(source.workflow ?? {}, result.selectedNodeIds), "workflow_draft_get(workflowId)");
  add("run", 30000, runMinimum(source.run ?? {}), "workflow_status(runId)");
  add("previousTurnResults", 18000, previousMinimum(source.previousTurnResults ?? []), "Saved source task and tool ledger; no write replay.");
  add("artifacts", 18000, (source.artifacts ?? []).map((artifact: Json) => ({
    artifactId: artifact.artifactId, runId: artifact.runId, byteLength: artifact.byteLength,
    sha256: artifact.sha256, offset: artifact.offset, nextOffset: artifact.offset,
    contentOmitted: true,
  })), "artifact_read(runId, artifactId, offset, maxBytes)");
  add("conversationCreatedWorkflows", 4000, [], "workflow_draft_get(workflowId)");
  const state = source.projectState;
  add("projectState", 16000, state?.status === "checked" ? {
    status: state.status, checkedAt: state.checkedAt,
    registeredConnections: { count: state.registeredConnections.count, items: [], truncated: state.registeredConnections.count > 0 },
    discovery: { status: state.discovery.status, toolCountKnown: state.discovery.toolCountKnown, currentCounts: state.discovery.currentCounts },
    interpretation: state.interpretation,
  } : state, "capability_search/capability_get; /discovery for the complete connection directory");
  const helpSource = { citations: source.citations ?? [], help: source.help ?? [] };
  source = { ...source, knowledge: helpSource };
  add("knowledge", 8000, { citations: [], help: [] }, "project_help_search(query, limit)");

  // Reserve space for section accounting before expanding any source.
  const bodyLimit = CONTEXT_BYTE_LIMIT - 5000, sections: Json = {};
  ensure(bytes(result) <= bodyLimit, "INPUT_INVALID", "Selected context identifiers exceed the model context budget.");
  for (const spec of specs) {
    const original = source[spec.key], originalBytes = bytes(original);
    const available = Math.min(spec.cap, bodyLimit - bytes(result) + bytes(result[spec.key]));
    let value = original, omissions: Json[] = [];
    if (originalBytes > available) {
      const directory = ["projectState","knowledge"].includes(spec.key) ? directoryWithin(original, available) : null;
      value = directory?.value ?? spec.minimum; omissions = directory?.omitted ?? [];
    }
    result[spec.key] = value;
    sections[spec.key] = {
      totalBytes: originalBytes, includedBytes: bytes(value), truncated: bytes(value) !== originalBytes,
      ...(omissions.length ? { omittedCollections: omissions } : {}),
      ...(bytes(value) !== originalBytes ? { range: "Structured projection; omitted fields/items remain in the original source.", retrieve: spec.retrieve } : {}),
    };
  }
  result.citations = result.knowledge.citations; result.help = result.knowledge.help; delete result.knowledge;
  const truncated = Object.values(sections).some((section: Json) => section.truncated);
  result.contextBudget = { limitBytes: CONTEXT_BYTE_LIMIT, encoding: "UTF-8", sections };
  if (truncated) Object.assign(result, { truncated: true, totalBytes, range: "Priority selected objects, then bounded source sections in UTF-8 bytes; request complete definitions/results by tool." });
  const text = JSON.stringify(result), includedBytes = Buffer.byteLength(text, "utf8");
  ensure(includedBytes <= CONTEXT_BYTE_LIMIT, "INPUT_INVALID", "Context accounting exceeds the model byte budget.");
  return { text, totalBytes, includedBytes, truncated, sections };
}
