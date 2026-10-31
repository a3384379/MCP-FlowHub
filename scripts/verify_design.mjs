#!/usr/bin/env node
/**
 * MCP FlowHub design-package static checks.
 *
 * Run from ANY working directory:
 *   node /absolute/path/to/flowhub-design/scripts/verify_design.mjs
 * Optional harness negative control (intentionally returns exit code 1):
 *   node /absolute/path/to/flowhub-design/scripts/verify_design.mjs --self-test-failure
 *
 * Requires Node.js built-ins only; no install, network, MCP, database, credentials,
 * or company files are used. This is a CUSTOM STATIC CHECKER, NOT a complete
 * JSON Schema Draft 2020-12 validator, protocol test, engine, security audit,
 * or proof that a real production binding is safe.
 *
 * Only the assertion keywords explicitly listed below are supported. Unknown
 * schema keywords fail the audit instead of being silently ignored. format
 * checks are intentionally a small local subset, not full RFC conformance.
 * Replace/supplement this checker with a pinned standards validator in CI.
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const designRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedTools = [
  'workflow_search', 'workflow_get', 'workflow_start', 'workflow_advance',
  'workflow_status', 'workflow_cancel', 'artifact_read',
];
const expectedNodes = [
  'input', 'mcp_tool', 'agent_task', 'condition',
  'report_template', 'end',
];
const counts = { positive: 0, negative: 0, failed: 0 };
const has = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const copy = value => structuredClone(value);
const stable = value => {
  if (Array.isArray(value)) return '[' + value.map(stable).join(',') + ']';
  if (isObject(value)) return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + stable(value[k])).join(',') + '}';
  return JSON.stringify(value);
};
const equal = (a, b) => stable(a) === stable(b);

class CheckError extends Error {
  constructor(code, message) { super(message); this.name = 'CheckError'; this.code = code; }
}
function requireThat(condition, code, message) {
  if (!condition) throw new CheckError(code, message);
}
function positive(name, fn) {
  try { fn(); counts.positive += 1; console.log('[PASS positive] ' + name); }
  catch (error) { counts.failed += 1; console.error('[FAIL positive] ' + name + ': ' + error.message); }
}
function negative(name, fn, expectedCode) {
  try {
    fn();
    counts.failed += 1;
    console.error('[FAIL negative] ' + name + ': invalid case was accepted');
  } catch (error) {
    if (!(error instanceof CheckError) || error.code !== expectedCode) {
      counts.failed += 1;
      console.error('[FAIL negative] ' + name + ': expected ' + expectedCode + ', got ' + (error.code || error.name) + ': ' + error.message);
    } else {
      counts.negative += 1;
      console.log('[PASS negative] ' + name + ' -> ' + expectedCode);
    }
  }
}
function load(relativePath) {
  return JSON.parse(readFileSync(resolve(designRoot, relativePath), 'utf8'));
}
function allJsonFiles(directory = designRoot, prefix = '') {
  const results = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'artifacts', 'coverage'].includes(entry.name)) continue;
    const relativePath = prefix + entry.name;
    if (entry.isDirectory()) results.push(...allJsonFiles(resolve(directory, entry.name), relativePath + '/'));
    else if (entry.isFile() && entry.name.endsWith('.json')) results.push(relativePath);
  }
  return results.sort();
}

const annotations = new Set(['$schema', '$id', '$defs', '$comment', 'title', 'description', 'default', 'examples']);
const assertions = new Set([
  '$ref', 'type', 'const', 'enum', 'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else',
  'properties', 'required', 'additionalProperties', 'propertyNames',
  'minProperties', 'maxProperties', 'items', 'minItems', 'maxItems', 'uniqueItems',
  'minLength', 'maxLength', 'pattern', 'format', 'minimum', 'maximum',
]);
function localRef(root, reference) {
  requireThat(typeof reference === 'string' && reference.startsWith('#/'), 'SCHEMA_AUDIT', 'Only document-local JSON Pointer $ref is supported');
  let target = root;
  for (const raw of reference.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    requireThat(isObject(target) && has(target, key), 'SCHEMA_AUDIT', 'Unresolved $ref: ' + reference);
    target = target[key];
  }
  return target;
}
function auditSchema(schema, root = schema, path = '$') {
  if (typeof schema === 'boolean') return;
  requireThat(isObject(schema), 'SCHEMA_AUDIT', path + ' is not an object/boolean schema');
  for (const key of Object.keys(schema)) {
    requireThat(annotations.has(key) || assertions.has(key), 'SCHEMA_AUDIT', path + ': unsupported keyword ' + key);
  }
  if (has(schema, '$ref')) localRef(root, schema.$ref);
  if (has(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    requireThat(types.length > 0 && new Set(types).size === types.length && types.every(type => ['object', 'array', 'string', 'boolean', 'integer', 'number', 'null'].includes(type)), 'SCHEMA_AUDIT', path + ': unsupported type');
  }
  if (has(schema, 'pattern')) {
    try { new RegExp(schema.pattern, 'u'); } catch { throw new CheckError('SCHEMA_AUDIT', path + ': invalid regular expression'); }
  }
  if (has(schema, 'required')) requireThat(Array.isArray(schema.required) && schema.required.every(x => typeof x === 'string'), 'SCHEMA_AUDIT', path + ': invalid required');
  for (const group of ['$defs', 'properties']) {
    if (has(schema, group)) {
      requireThat(isObject(schema[group]), 'SCHEMA_AUDIT', path + ': invalid ' + group);
      for (const [key, child] of Object.entries(schema[group])) auditSchema(child, root, path + '.' + group + '.' + key);
    }
  }
  for (const key of ['items', 'additionalProperties', 'propertyNames', 'if', 'then', 'else']) {
    if (has(schema, key)) auditSchema(schema[key], root, path + '.' + key);
  }
  for (const key of ['oneOf', 'anyOf', 'allOf']) {
    if (has(schema, key)) {
      requireThat(Array.isArray(schema[key]) && schema[key].length > 0, 'SCHEMA_AUDIT', path + ': empty combinator');
      schema[key].forEach((child, i) => auditSchema(child, root, path + '.' + key + '[' + i + ']'));
    }
  }
}
function typeMatches(value, type) {
  if (Array.isArray(type)) return type.some(candidate => typeMatches(value, candidate));
  switch (type) {
    case 'null': return value === null;
    case 'object': return isObject(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'integer': return typeof value === 'number' && Number.isSafeInteger(value);
    default: return false;
  }
}
function formatMatches(value, format) {
  if (format === 'date-time') return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(value) && Number.isFinite(Date.parse(value));
  if (format === 'date') return /^\d{4}-\d{2}-\d{2}$/u.test(value) && Number.isFinite(Date.parse(value));
  if (format === 'uuid') return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
  if (format === 'uri') { try { return Boolean(new URL(value).protocol); } catch { return false; } }
  throw new CheckError('SCHEMA_AUDIT', 'Unsupported format: ' + format);
}
function errorsFor(value, schema, root = schema, path = '$', depth = 0) {
  if (depth > 100) return [path + ': custom checker depth exceeded'];
  if (schema === true) return [];
  if (schema === false) return [path + ': false schema'];
  const errors = [];
  const visit = (v, s, p = path) => errorsFor(v, s, root, p, depth + 1);
  if (has(schema, '$ref')) errors.push(...visit(value, localRef(root, schema.$ref)));
  if (has(schema, 'type') && !typeMatches(value, schema.type)) return [...errors, path + ': expected ' + schema.type];
  if (has(schema, 'const') && !equal(value, schema.const)) errors.push(path + ': const mismatch');
  if (has(schema, 'enum') && !schema.enum.some(v => equal(value, v))) errors.push(path + ': enum mismatch');
  for (const kind of ['oneOf', 'anyOf']) {
    if (has(schema, kind)) {
      const matches = schema[kind].filter(sub => visit(value, sub).length === 0).length;
      if ((kind === 'oneOf' && matches !== 1) || (kind === 'anyOf' && matches < 1)) errors.push(path + ': ' + kind + ' matched ' + matches);
    }
  }
  for (const sub of schema.allOf || []) errors.push(...visit(value, sub));
  if (has(schema, 'if')) errors.push(...visit(value, (visit(value, schema.if).length === 0 ? schema.then : schema.else) ?? {}));
  if (isObject(value)) {
    for (const required of schema.required || []) if (!has(value, required)) errors.push(path + ': missing ' + required);
    const properties = schema.properties || {};
    for (const [key, item] of Object.entries(value)) {
      if (has(schema, 'propertyNames')) errors.push(...visit(key, schema.propertyNames, path + '.<key>'));
      if (has(properties, key)) errors.push(...visit(item, properties[key], path + '.' + key));
      else if (schema.additionalProperties === false) errors.push(path + ': unknown ' + key);
      else if (isObject(schema.additionalProperties)) errors.push(...visit(item, schema.additionalProperties, path + '.' + key));
    }
    const size = Object.keys(value).length;
    if (size < (schema.minProperties ?? 0) || size > (schema.maxProperties ?? Infinity)) errors.push(path + ': object size');
  }
  if (Array.isArray(value)) {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? Infinity)) errors.push(path + ': array size');
    if (schema.uniqueItems && new Set(value.map(stable)).size !== value.length) errors.push(path + ': duplicate array item');
    if (has(schema, 'items')) value.forEach((v, i) => errors.push(...visit(v, schema.items, path + '[' + i + ']')));
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (length < (schema.minLength ?? 0) || length > (schema.maxLength ?? Infinity)) errors.push(path + ': string length');
    if (has(schema, 'pattern') && !new RegExp(schema.pattern, 'u').test(value)) errors.push(path + ': pattern mismatch');
    if (has(schema, 'format') && !formatMatches(value, schema.format)) errors.push(path + ': format mismatch');
  }
  if (typeof value === 'number' && (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) errors.push(path + ': numeric bounds');
  return errors;
}
function structure(value, schema, root = schema) {
  const errors = errorsFor(value, schema, root);
  requireThat(errors.length === 0, 'STRUCTURE', errors.slice(0, 6).join('; '));
}
function pointerSegments(pointer) {
  requireThat(typeof pointer === 'string' && /^(?:\/(?:[^~/]|~[01])*)*$/u.test(pointer), 'POINTER', 'Malformed JSON Pointer');
  const parts = pointer === '' ? [] : pointer.slice(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  requireThat(!parts.some(s => ['__proto__', 'prototype', 'constructor'].includes(s)), 'PROTOTYPE_PATH', 'Prototype-related path is not allowed');
  return parts;
}
function pathOverlap(left, right) {
  const a = pointerSegments(left), b = pointerSegments(right);
  return a.slice(0, Math.min(a.length, b.length)).every((segment, i) => segment === b[i]);
}
function mappingsIn(value, found = []) {
  if (Array.isArray(value)) value.forEach(v => mappingsIn(v, found));
  else if (isObject(value)) {
    if (isObject(value.ref) && ['input', 'node'].includes(value.ref.source)) found.push(value.ref);
    Object.values(value).forEach(v => mappingsIn(v, found));
  }
  return found;
}
function checkCatalog(catalog) {
  const refs = catalog.bindings.map(b => b.bindingRef);
  requireThat(new Set(refs).size === refs.length, 'DUPLICATE_BINDING', 'Binding refs must be unique');
  for (const binding of catalog.bindings) {
    const url = new URL(binding.endpoint);
    requireThat(url.protocol === 'https:' && url.hostname.endsWith('.example.invalid'), 'NON_DEMO_ENDPOINT', 'Only reserved mock endpoints are allowed in this package');
    requireThat(binding.endpointAllowlist.includes(url.hostname), 'ENDPOINT_ALLOWLIST', 'Endpoint is absent from its allowlist');
    requireThat(binding.credentialRef.startsWith('secret://demo/'), 'NON_DEMO_SECRET', 'Only synthetic credential refs are allowed');
    requireThat(binding.validationStatus === 'MOCK_VERIFIED' && binding.simulationOnly && !binding.realExecutionAllowed, 'MOCK_BOUNDARY', 'Example binding must remain mock-only');
    requireThat(binding.lockedArguments['/environment'] === binding.environment, 'BINDING_LOCK', 'Locked environment must equal binding environment');
  }
}
function checkGraph(workflow, catalog, { realPublication = false } = {}) {
  const nodeIds = workflow.nodes.map(n => n.id);
  requireThat(new Set(nodeIds).size === nodeIds.length, 'DUPLICATE_NODE', 'Node IDs must be unique');
  const nodes = new Map(workflow.nodes.map(n => [n.id, n]));
  const starts = workflow.nodes.filter(n => n.type === 'input');
  requireThat(starts.length === 1, 'START_COUNT', 'Exactly one input node is required');
  requireThat(workflow.nodes.some(n => n.type === 'end'), 'END_REQUIRED', 'An end node is required');
  requireThat(!(workflow.mode === 'auto' && workflow.nodes.some(n => n.type === 'agent_task')), 'MODE', 'auto cannot contain agent_task');
  const outgoing = new Map(nodeIds.map(id => [id, []]));
  const incoming = new Map(nodeIds.map(id => [id, []]));
  for (const edge of workflow.edges) {
    requireThat(nodes.has(edge.source) && nodes.has(edge.target), 'DANGLING_EDGE', 'Edge references missing node');
    outgoing.get(edge.source).push(edge); incoming.get(edge.target).push(edge);
  }
  for (const node of workflow.nodes) {
    const ports = outgoing.get(node.id).map(e => e.port).sort();
    const expected = node.type === 'condition' ? ['false', 'true'] : node.type === 'end' ? [] : ['next'];
    requireThat(equal(ports, expected), 'BRANCH_PORTS', 'Invalid or parallel outgoing edges: ' + node.id);
  }
  const visited = new Set(), active = new Set();
  function visit(id) {
    requireThat(!active.has(id), 'CYCLE', 'Cycle detected at ' + id);
    if (visited.has(id)) return;
    active.add(id); outgoing.get(id).forEach(e => visit(e.target)); active.delete(id); visited.add(id);
  }
  visit(starts[0].id);
  requireThat(visited.size === nodes.size, 'UNREACHABLE_NODE', 'All fixture nodes must be reachable');
  const dominators = new Map(nodeIds.map(id => [id, new Set(nodeIds)]));
  dominators.set(starts[0].id, new Set([starts[0].id]));
  let changed = true;
  while (changed) {
    changed = false;
    for (const id of nodeIds) {
      if (id === starts[0].id) continue;
      const predecessors = incoming.get(id).map(e => dominators.get(e.source));
      const next = new Set([id, ...nodeIds.filter(candidate => predecessors.every(p => p.has(candidate)))]);
      if (!equal([...next].sort(), [...dominators.get(id)].sort())) { dominators.set(id, next); changed = true; }
    }
  }
  const byBinding = new Map(catalog.bindings.map(b => [b.bindingRef, b]));
  for (const node of workflow.nodes) {
    for (const reference of mappingsIn(node.config)) {
      pointerSegments(reference.pointer);
      if (reference.source === 'node') {
        requireThat(nodes.has(reference.nodeId), 'REFERENCE_NODE', 'Reference names a missing node');
        requireThat(reference.nodeId !== node.id && dominators.get(node.id).has(reference.nodeId), 'REFERENCE_DOMINANCE', 'A required ref must be on every selected path: ' + reference.nodeId + ' -> ' + node.id);
      }
    }
    for (const mappings of [node.config.argumentsMappings, node.config.inputMappings].filter(Boolean)) {
      const destinations = Object.keys(mappings);
      destinations.forEach(pointerSegments);
      destinations.forEach((left, i) => destinations.slice(i + 1).forEach(right => requireThat(!pathOverlap(left, right), 'OVERLAPPING_MAPPING', 'Parent/child destinations overlap')));
    }
    if (node.type !== 'mcp_tool') continue;
    const binding = byBinding.get(workflow.bindings[node.config.bindingKey]);
    requireThat(Boolean(binding), 'BINDING_MISSING', 'Unknown binding role/ref');
    requireThat(binding.environment === workflow.environment, 'ENVIRONMENT', 'Cross-environment binding is not allowed');
    requireThat(binding.allowedTools.includes(node.config.toolName), 'TOOL_ALLOWLIST', 'Tool is not allowed by binding');
    if (realPublication) {
      requireThat(binding.validationStatus === 'BINDING_VERIFIED' && !binding.simulationOnly && binding.realExecutionAllowed, 'MOCK_REAL_EXECUTION', 'MOCK_VERIFIED cannot authorize real execution');
      requireThat(/^sha256:[0-9a-f]{64}$/u.test(node.config.toolSchemaHash), 'PLACEHOLDER_HASH', 'Real publication requires a verified schema hash');
    }
    for (const destination of Object.keys(node.config.argumentsMappings)) {
      for (const locked of Object.keys(binding.lockedArguments)) requireThat(!pathOverlap(destination, locked), 'LOCKED_ARGUMENT', 'A mapping overlaps locked environment/resource routing');
    }
    if (node.config.bindingKey === 'db') {
      requireThat(equal(node.config.argumentsMappings['/templateId'], { value: 'order-by-number-v1' }), 'TEMPLATE_LOCKED', 'Fixture DB query template must be fixed');
    }
  }
}
function verifyFixtureOutputs(workflow) {
  const nodes = new Map(workflow.nodes.map(n => [n.id, n]));
  requireThat(equal(Object.keys(nodes.get('plan').config.outputSchema.properties).sort(), ['queryNeeded', 'orderNo', 'reason', 'evidenceRefs'].sort()), 'PLAN_CONTRACT', 'Plan must not accept free SQL, template IDs, or environment');
  requireThat(equal(Object.keys(nodes.get('report').config.outputSchema.properties).sort(), ['reportMarkdown', 'evidenceRefs'].sort()), 'REPORT_CONTRACT', 'Report must carry actual Markdown and evidence refs');
  requireThat(nodes.get('report').config.fallbackTemplateRef === 'incident-markdown/v1', 'FALLBACK_CONTRACT', 'Predeclared fallback missing');
}
function verifySameGraph(production, staging) {
  const normalized = copy(staging);
  for (const key of ['workflowId', 'name', 'environment', 'bindings']) normalized[key] = copy(production[key]);
  normalized.nodes.find(n => n.id === 'log').config.toolName = production.nodes.find(n => n.id === 'log').config.toolName;
  requireThat(equal(normalized, production), 'FIXTURE_DRIFT', 'Production/staging differ beyond the five permitted categories');
}
function validateStart(call, workflow) {
  const args = call.arguments;
  requireThat(args.workflowId === workflow.workflowId && args.version === workflow.version, 'VERSION', 'Start must select the exact fixture version');
  requireThat(args.mode === workflow.mode, 'MODE', 'Start mode must match the published fixture');
  structure(args.inputs, workflow.inputSchema);
  requireThat(Date.parse(args.inputs.from) < Date.parse(args.inputs.to), 'TIME_ORDER', 'from must precede to');
}
function validateAgent(call, node, state = 'WAITING_AGENT') {
  requireThat(state === 'WAITING_AGENT', 'CHECKPOINT_STATE', 'MCP advance cannot approve WAITING_APPROVAL');
  const submission = call.arguments.submission;
  if (submission.type === 'host_skill_unavailable') {
    requireThat(node.config.kind === 'host_skill', 'FALLBACK_CONTEXT', 'Only a host_skill checkpoint accepts unavailable');
    if (submission.useDeclaredFallback) requireThat(Boolean(node.config.fallbackTemplateRef), 'FALLBACK_UNDECLARED', 'Caller cannot invent a fallback');
    return;
  }
  structure(submission.payload, node.config.outputSchema);
}

console.log('FlowHub design verification');
console.log('Root: ' + designRoot);
console.log('自定义静态检查，不是完整 JSON Schema 2020-12 验证；不运行真实 MCP、引擎、数据库或审批。');
try {
  const jsonFiles = allJsonFiles();
  const parsedArtifacts = new Map(jsonFiles.map(file => [file, load(file)]));
  const workflowSchema = load('contracts/workflow.schema.json');
  const toolSchema = load('contracts/mcp-tool-inputs.schema.json');
  const resultSchema = load('contracts/mock-results.schema.json');
  const production = load('examples/incident-production.json');
  const staging = load('examples/incident-staging.json');
  const catalog = load('examples/bindings.example.json');
  const mockLog = load('examples/mock-log-result.json');
  const mockDb = load('examples/mock-db-result.json');
  const plan = production.nodes.find(n => n.id === 'plan');
  const report = production.nodes.find(n => n.id === 'report');
  const baseAdvance = {
    runId: 'run_DEMO_001', checkpointId: 'cp_DEMO_001', checkpointToken: 'DEMO_EPHEMERAL_TOKEN',
    expectedRevision: 1, idempotencyKey: 'DEMO-advance-001',
  };
  const planPayload = { queryNeeded: true, orderNo: 'DEMO-1001', reason: '合成日志提示需要核对记录', evidenceRefs: ['art_DEMO_LOG'] };
  const calls = {
    workflow_search: { query: '生产问题排查', environment: 'production', tags: ['incident'], limit: 10 },
    workflow_get: { workflowId: production.workflowId, version: production.version },
    workflow_start: { workflowId: production.workflowId, version: production.version, mode: production.mode, inputs: copy(production.inputSchema.examples[0]), idempotencyKey: 'DEMO-start-001' },
    workflow_advance: { ...baseAdvance, submission: { type: 'agent_result', payload: planPayload } },
    workflow_status: { runId: 'run_DEMO_001', afterEventSeq: 0, limit: 50 },
    workflow_cancel: { runId: 'run_DEMO_001', expectedRevision: 1, reason: '合成取消测试', idempotencyKey: 'DEMO-cancel-001' },
    artifact_read: { runId: 'run_DEMO_001', artifactId: 'art_DEMO_LOG', offset: 0, maxBytes: 65536 },
  };
  const call = tool => ({ tool, arguments: copy(calls[tool]) });
  positive('parse all ' + jsonFiles.length + ' regular JSON artifacts', () => assert.equal(parsedArtifacts.size, jsonFiles.length));
  positive('workflow schema uses supported local subset', () => auditSchema(workflowSchema));
  positive('seven-tool schema uses supported local subset', () => auditSchema(toolSchema));
  positive('mock result schema uses supported local subset', () => auditSchema(resultSchema));
  positive('Draft 2020-12 declarations', () => {
    assert.equal(workflowSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(toolSchema.$schema, workflowSchema.$schema);
    assert.equal(resultSchema.$schema, workflowSchema.$schema);
  });
  positive('exactly seven advertised tool names and branches', () => {
    assert.deepEqual([...toolSchema.properties.tool.enum].sort(), [...expectedTools].sort());
    assert.deepEqual(toolSchema.oneOf.map(b => b.properties.tool.const).sort(), [...expectedTools].sort());
    for (const name of expectedTools) assert.equal(toolSchema.$defs[name].additionalProperties, false);
  });
  positive('exactly seven node types', () => assert.deepEqual(workflowSchema.$defs.node.oneOf.map(s => s.properties.type.const).sort(), [...expectedNodes].sort()));
  for (const workflow of [production, staging]) {
    positive(workflow.workflowId + ': structure', () => structure(workflow, workflowSchema));
    positive(workflow.workflowId + ': input examples', () => workflow.inputSchema.examples.forEach(input => structure(input, workflow.inputSchema)));
    positive(workflow.workflowId + ': graph and safety fixture', () => checkGraph(workflow, catalog));
    positive(workflow.workflowId + ': agent/report output contracts', () => verifyFixtureOutputs(workflow));
  }
  positive('binding catalog structure', () => structure(catalog, workflowSchema.$defs.bindingCatalog, workflowSchema));
  positive('binding catalog mock boundaries', () => checkCatalog(catalog));
  positive('same graph across environments', () => verifySameGraph(production, staging));
  positive('mock log result structure', () => structure(mockLog, resultSchema.$defs.logSearchResult, resultSchema));
  positive('mock database result structure', () => structure(mockDb, resultSchema.$defs.queryTemplateResult, resultSchema));
  const resultRegistry = {
    'flowhub://schemas/log-search-result/v1': resultSchema.$defs.logSearchResult,
    'flowhub://schemas/query-template-result/v1': resultSchema.$defs.queryTemplateResult,
  };
  function checkResult(result, nodeId, workflow) {
    const node = workflow.nodes.find(n => n.id === nodeId);
    const selectedSchema = resultRegistry[node.config.outputSchemaRef];
    requireThat(Boolean(selectedSchema), 'RESULT_SCHEMA', 'Unknown built-in result schema ref');
    structure(result, selectedSchema, resultSchema);
    requireThat(result.environment === workflow.environment, 'RESULT_ENVIRONMENT', 'Result environment differs from fixed workflow');
    const binding = catalog.bindings.find(b => b.bindingRef === workflow.bindings[node.config.bindingKey]);
    const records = nodeId === 'log' ? result.logs : result.rows;
    requireThat(records.length <= Math.min(workflow.budgets.maxRows, binding.maxRows), 'RESULT_ROW_LIMIT', 'Result exceeds effective row budget');
    requireThat(Buffer.byteLength(JSON.stringify(result), 'utf8') <= workflow.budgets.maxOutputBytes, 'RESULT_BYTE_LIMIT', 'Result exceeds byte budget');
    if (nodeId === 'db') {
      requireThat(result.rowCount === result.rows.length, 'RESULT_ROW_COUNT', 'rowCount differs from returned rows');
      const sentinel = { production: 'PROD_ONLY_SENTINEL_017', staging: 'STAGE_ONLY_SENTINEL_029' }[workflow.environment];
      requireThat(result.rows.every(row => row.sentinel === sentinel), 'RESULT_SENTINEL', 'Synthetic environment sentinel mismatch');
    }
  }
  positive('mock log result registry and effective budget', () => checkResult(mockLog, 'log', production));
  positive('mock DB result registry, environment sentinel and count', () => checkResult(mockDb, 'db', production));
  positive('staging result synthetic in-memory variant', () => {
    const value = copy(mockDb); value.environment = 'staging';
    value.rows.forEach(row => { row.sentinel = 'STAGE_ONLY_SENTINEL_029'; });
    checkResult(value, 'db', staging);
  });
  for (const tool of expectedTools) positive(tool + ': input structure', () => structure(call(tool), toolSchema));
  positive('workflow_start: dynamic workflow input', () => validateStart(call('workflow_start'), production));
  positive('workflow_advance: dynamic plan output', () => validateAgent(call('workflow_advance'), plan));
  for (const useDeclaredFallback of [true, false]) {
    positive('host skill unavailable: fallback=' + useDeclaredFallback, () => {
      const request = { tool: 'workflow_advance', arguments: { ...baseAdvance, submission: { type: 'host_skill_unavailable', useDeclaredFallback } } };
      structure(request, toolSchema); validateAgent(request, report);
    });
  }
  positive('workflow_get allows omitted version syntactically', () => structure({ tool: 'workflow_get', arguments: { workflowId: production.workflowId } }, toolSchema));
  positive('report payload contains actual Markdown', () => structure({ reportMarkdown: '# 合成报告\n\n仅用于静态验证。', evidenceRefs: [] }, report.config.outputSchema));
  positive('effective fixture limits are minimum of workflow/binding', () => {
    for (const workflow of [production, staging]) {
      const binding = catalog.bindings.find(b => b.bindingRef === workflow.bindings.db);
      assert.equal(Math.min(workflow.budgets.maxRows, binding.maxRows), 100);
      assert.equal(Math.min(workflow.budgets.maxToolSeconds, binding.timeoutSeconds), 30);
      assert.equal(workflow.budgets.maxOutputBytes, 262144);
    }
  });
  const mutateWorkflow = (name, mutation, code = 'STRUCTURE', semantic = false) => negative(name, () => {
    const changed = copy(production); mutation(changed);
    if (semantic) checkGraph(changed, catalog); else structure(changed, workflowSchema);
  }, code);
  mutateWorkflow('unknown workflow field', w => { w.unsafe = true; });
  mutateWorkflow('unknown MCP config field', w => { w.nodes[1].config.shell = 'forbidden'; });
  mutateWorkflow('unknown mapping expression', w => { w.nodes[1].config.argumentsMappings['/question'].expression = 'forbidden'; });
  mutateWorkflow('node ref without nodeId', w => { delete w.nodes[2].config.inputMappings['/logResult'].ref.nodeId; });
  mutateWorkflow('non-pointer destination key', w => { w.nodes[1].config.argumentsMappings.orderNo = { value: 'DEMO-1001' }; });
  mutateWorkflow('arbitrary code node', w => { w.nodes[1].type = 'run_code'; });
  mutateWorkflow('unsupported edge port', w => { w.edges[0].port = 'parallel'; });
  mutateWorkflow('unsupported condition operator', w => { w.nodes[3].config.expression.op = 'eval'; });
  mutateWorkflow('invalid version string', w => { w.version = 'latest'; });
  mutateWorkflow('remote data-schema ref', w => { w.inputSchema.$ref = 'https://example.invalid/schema'; });
  mutateWorkflow('removed approval node rejected', w => { w.nodes[4].type = 'approval'; });
  mutateWorkflow('invalid environment value', w => { w.environment = 'production2'; });
  mutateWorkflow('duplicate node id', w => { w.nodes.push(copy(w.nodes[0])); }, 'DUPLICATE_NODE', true);
  mutateWorkflow('cross-environment binding', w => { w.environment = 'staging'; }, 'ENVIRONMENT', true);
  mutateWorkflow('optional DB used as required ref', w => { w.nodes.find(n => n.id === 'synthesize').config.inputMappings['/db'] = { ref: { source: 'node', nodeId: 'db', pointer: '' } }; }, 'REFERENCE_DOMINANCE', true);
  mutateWorkflow('auto contains agent checkpoint', w => { w.mode = 'auto'; }, 'MODE', true);
  mutateWorkflow('tool outside binding allowlist', w => { w.nodes[1].config.toolName = 'delete_logs'; }, 'TOOL_ALLOWLIST', true);
  mutateWorkflow('query template is changed', w => { w.nodes.find(n => n.id === 'db').config.argumentsMappings['/templateId'] = { value: 'unapproved-template' }; }, 'TEMPLATE_LOCKED', true);
  mutateWorkflow('environment override mapping', w => { w.nodes.find(n => n.id === 'db').config.argumentsMappings['/environment'] = { value: 'staging' }; }, 'LOCKED_ARGUMENT', true);
  mutateWorkflow('prototype destination path', w => { w.nodes.find(n => n.id === 'db').config.argumentsMappings['/__proto__/admin'] = { value: true }; }, 'PROTOTYPE_PATH', true);
  mutateWorkflow('cycle', w => { w.edges.find(e => e.source === 'report').target = 'log'; }, 'CYCLE', true);
  mutateWorkflow('parallel branch', w => { w.edges.push({ source: 'log', target: 'synthesize', port: 'next' }); }, 'BRANCH_PORTS', true);
  mutateWorkflow('overlapping parent/child mapping', w => { w.nodes.find(n => n.id === 'db').config.argumentsMappings['/parameters'] = { value: {} }; }, 'OVERLAPPING_MAPPING', true);
  negative('mock fixtures cannot authorize real publication', () => checkGraph(production, catalog, { realPublication: true }), 'MOCK_REAL_EXECUTION');
  negative('duplicate binding reference', () => { const value = copy(catalog); value.bindings.push(copy(value.bindings[0])); checkCatalog(value); }, 'DUPLICATE_BINDING');
  negative('binding environment lock mismatch', () => { const value = copy(catalog); value.bindings[0].lockedArguments['/environment'] = 'staging'; checkCatalog(value); }, 'BINDING_LOCK');
  negative('unauthorized fixture graph drift', () => { const value = copy(staging); value.nodes[2].title += ' changed'; verifySameGraph(production, value); }, 'FIXTURE_DRIFT');
  negative('mock output unknown field', () => { const value = copy(mockLog); value.unsafe = true; structure(value, resultSchema.$defs.logSearchResult, resultSchema); }, 'STRUCTURE');
  negative('mock output must be explicitly synthetic', () => { const value = copy(mockDb); value.synthetic = false; structure(value, resultSchema.$defs.queryTemplateResult, resultSchema); }, 'STRUCTURE');
  negative('result schema does not imply environment correctness', () => { const value = copy(mockDb); value.environment = 'staging'; checkResult(value, 'db', production); }, 'RESULT_ENVIRONMENT');
  negative('incorrect rowCount', () => { const value = copy(mockDb); value.rowCount = 2; checkResult(value, 'db', production); }, 'RESULT_ROW_COUNT');
  negative('wrong environment sentinel', () => { const value = copy(mockDb); value.rows[0].sentinel = 'STAGE_ONLY_SENTINEL_029'; checkResult(value, 'db', production); }, 'RESULT_SENTINEL');
  negative('result exceeds stricter workflow rows', () => { const value = copy(mockLog); value.logs = Array.from({ length: 101 }, () => copy(value.logs[0])); checkResult(value, 'log', production); }, 'RESULT_ROW_LIMIT');
  negative('multibyte result exceeds byte budget despite string limits', () => { const value = copy(mockLog); value.logs = Array.from({ length: 100 }, () => ({ ...copy(value.logs[0]), message: '测'.repeat(2000) })); checkResult(value, 'log', production); }, 'RESULT_BYTE_LIMIT');
  for (const tool of expectedTools) {
    negative(tool + ': unknown argument rejected', () => { const value = call(tool); value.arguments.unknownField = true; structure(value, toolSchema); }, 'STRUCTURE');
  }
  negative('eighth generic tool rejected', () => structure({ tool: 'execute_any_tool', arguments: {} }, toolSchema), 'STRUCTURE');
  const mutateCall = (name, tool, mutation) => negative(name, () => { const value = call(tool); mutation(value.arguments); structure(value, toolSchema); }, 'STRUCTURE');
  mutateCall('search limit overflow', 'workflow_search', a => { a.limit = 51; });
  mutateCall('duplicate search tags', 'workflow_search', a => { a.tags = ['incident', 'incident']; });
  mutateCall('start direct environment override', 'workflow_start', a => { a.environment = 'staging'; });
  mutateCall('start missing version', 'workflow_start', a => { delete a.version; });
  mutateCall('advance missing checkpoint token', 'workflow_advance', a => { delete a.checkpointToken; });
  mutateCall('advance invalid revision', 'workflow_advance', a => { a.expectedRevision = 0; });
  mutateCall('advance fake human approval', 'workflow_advance', a => { a.submission.approved = true; });
  mutateCall('status limit overflow', 'workflow_status', a => { a.limit = 201; });
  mutateCall('artifact oversized read', 'artifact_read', a => { a.maxBytes = 262145; });
  mutateCall('artifact negative offset', 'artifact_read', a => { a.offset = -1; });
  mutateCall('artifact arbitrary path field', 'artifact_read', a => { a.path = '../../not-read'; });
  negative('dynamic input environment rejected by second validation', () => {
    const value = call('workflow_start'); value.arguments.inputs.environment = 'staging';
    structure(value, toolSchema); validateStart(value, production);
  }, 'STRUCTURE');
  negative('reversed input time range', () => { const value = call('workflow_start'); [value.arguments.inputs.from, value.arguments.inputs.to] = [value.arguments.inputs.to, value.arguments.inputs.from]; validateStart(value, production); }, 'TIME_ORDER');
  negative('start cannot change published mode', () => { const value = call('workflow_start'); value.arguments.mode = 'auto'; validateStart(value, production); }, 'MODE');
  for (const forbidden of ['sql', 'templateId', 'environment', 'approved']) {
    negative('dynamic Agent payload rejects ' + forbidden, () => {
      const value = call('workflow_advance'); value.arguments.submission.payload[forbidden] = 'forbidden';
      structure(value, toolSchema); validateAgent(value, plan);
    }, 'STRUCTURE');
  }
  negative('advance cannot approve WAITING_APPROVAL', () => validateAgent(call('workflow_advance'), plan, 'WAITING_APPROVAL'), 'CHECKPOINT_STATE');
  negative('fallback from non-Skill checkpoint', () => {
    const value = { tool: 'workflow_advance', arguments: { ...baseAdvance, submission: { type: 'host_skill_unavailable', useDeclaredFallback: true } } };
    structure(value, toolSchema); validateAgent(value, plan);
  }, 'FALLBACK_CONTEXT');
  negative('undeclared fallback', () => {
    const node = copy(report); delete node.config.fallbackTemplateRef;
    const value = { tool: 'workflow_advance', arguments: { ...baseAdvance, submission: { type: 'host_skill_unavailable', useDeclaredFallback: true } } };
    structure(value, toolSchema); validateAgent(value, node);
  }, 'FALLBACK_UNDECLARED');
  negative('unsupported validator keyword is not silently ignored', () => auditSchema({ type: 'string', unknownAssertion: true }), 'SCHEMA_AUDIT');
  negative('external schema reference is never fetched', () => auditSchema({ $ref: 'https://example.invalid/not-fetched' }), 'SCHEMA_AUDIT');
  if (process.argv.includes('--self-test-failure')) positive('intentional harness exit-code control', () => { throw new CheckError('INTENTIONAL', 'Requested negative control; exit code must be 1'); });
} catch (error) {
  counts.failed += 1;
  console.error('[FAIL setup] ' + error.message);
}
console.log('\nSummary: ' + counts.positive + ' positive passed; ' + counts.negative + ' negative passed; ' + counts.failed + ' failed.');
console.log('Boundary: custom static subset checks only. No full Draft 2020-12/meta-schema conformance, no real MCP/SDK/engine/CAS/authorization execution, no evidence that production is safe.');
process.exitCode = counts.failed === 0 ? 0 : 1;

