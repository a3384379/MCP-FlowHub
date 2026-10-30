import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import {
  hash,
  REPORT_HEADINGS,
  type Json,
  type Workflow,
} from "../../packages/contracts/src/domain.js";
import { Repository } from "../../packages/persistence/src/repository.js";
import { Vault } from "../../packages/security/src/index.js";
import { Engine } from "../../packages/workflow-core/src/engine.js";
import type { Connectors } from "../../packages/mcp-connectors/src/registry.js";
import { validateReportEvidence } from "../../packages/workflow-core/src/report-verification.js";

const first = "art_11111111-1111-4111-8111-111111111111";
const second = "art_22222222-2222-4222-8222-222222222222";
const foreign = "art_33333333-3333-4333-8333-333333333333";
const expired = "art_44444444-4444-4444-8444-444444444444";
const absent = "art_55555555-5555-4555-8555-555555555555";
const artifact = (
  id = first,
  content = "合成证据：仅供回归测试。",
  runId = "run_current",
) => ({
  id,
  runId,
  nodeId: "start",
  content,
  mimeType: "text/plain",
  sha256: hash(content),
  byteLength: Buffer.byteLength(content),
  createdAt: new Date().toISOString(),
  expiresAt: Date.now() + 3600000,
  verification: { contentStored: true },
});
const row = (a: Json) => `- ${a.id} / ${a.sha256} / ${a.byteLength} bytes`;
const report = (index: string, body = "合成范围，事实审查未执行。") =>
  REPORT_HEADINGS.map(
    (heading) => `## ${heading}\n\n${heading === "证据索引" ? index : body}`,
  ).join("\n\n");
const hiddenChapters = (index: string, opening: string, closing: string) =>
  `${opening}\n` +
  REPORT_HEADINGS.filter((heading) => heading !== "证据索引")
    .map((heading) => `## ${heading}\n合成段落。`)
    .join("\n\n") +
  `\n${closing}\n\n## 证据索引\n\n${index}`;
const explainedReport = (index: string) =>
  report(index)
    .replace(
      /^## (.+)$/gm,
      (_match, heading: string) =>
        `   ### ${heading}${heading === "问题摘要" ? " (synthetic scope)" : "（合成范围说明）"} ###`,
    )
    .replaceAll("\n", "\r\n");
const invalid = (text: string, refs: string[], artifacts: Json[]) =>
  assert.throws(() => validateReportEvidence(text, refs, artifacts), {
    code: "ARTIFACT_INVALID",
  });

test("report evidence accepts canonical template rows and explicit host table rows", () => {
  const a = artifact(),
    b = artifact(second, "another synthetic record");
  validateReportEvidence(
    report([row(a), row(b)].join("\n"), `日志声明：${a.id} / ${a.sha256}`),
    [a.id, b.id],
    [a, b],
  );
  validateReportEvidence(
    report(
      "| artifactId | sha256 | byteLength |\n| --- | --- | --- |\n" +
        `| \`${a.id}\` | \`sha256:${a.sha256.toUpperCase()}\` | ${a.byteLength} bytes |`,
    ).replaceAll("\n", "\r\n"),
    [a.id],
    [a],
  );
  validateReportEvidence(report(`- ${a.id} / sha256:${a.sha256}`), [a.id], [a]);
  for (const body of [
    `正文声明：${a.id} / ${a.sha256}。`,
    `正文声明：\`${a.id}\` / \`sha256:${a.sha256}\`，其余范围仍待核验。`,
    `正文声明：${a.id} / ${a.sha256} / ${a.byteLength} bytes；人工审查未执行。`,
    `Evidence (${a.id} / ${a.sha256} / ${a.byteLength} bytes).`,
  ])
    validateReportEvidence(report(row(a), body), [a.id], [a]);
  validateReportEvidence(report("无证据。"), [], []);
});

test("report hashes must be bound to each indexed artifact, with no body-hash substitution", () => {
  const a = artifact(),
    b = artifact(second, "different synthetic content");
  invalid(report(`- ${a.id} / ${"0".repeat(64)}`), [a.id], [a]);
  invalid(report(`- ${a.id} / ${b.sha256}`), [a.id], [a, b]);
  invalid(report(a.id, `正文碰巧出现摘要 ${a.sha256}`), [a.id], [a]);
  invalid(
    report("无证据。", `${a.id}，其摘要单独写作 ${a.sha256}`),
    [a.id],
    [a],
  );
  invalid(report(`- ${a.id} / ${"a".repeat(63)}`), [a.id], [a]);
  invalid(report(`- ${a.id} / ${a.sha256}suffix`), [a.id], [a]);
  invalid(
    report(row(a), `另一处声明：${a.id} / ${"0".repeat(64)}`),
    [a.id],
    [a],
  );
  for (const bytes of [
    "9999 bytes",
    "not-bytes",
    "1.5 bytes",
    "1,000 bytes",
    "",
    "-1 bytes",
  ]) {
    invalid(
      report(row(a), `正文声明：${a.id} / ${a.sha256} / ${bytes}`),
      [a.id],
      [a],
    );
    invalid(
      report(row(a), `正文声明：${a.id} / ${a.sha256} / ${bytes}。`),
      [a.id],
      [a],
    );
  }
});

test("report index rejects ambiguous duplicates, undeclared references and invalid lengths", () => {
  const a = artifact(),
    b = artifact(second);
  invalid(report(row(a) + "\n" + row(a)), [a.id], [a]);
  invalid(report(row(a) + `\n- ${a.id} / ${"0".repeat(64)}`), [a.id], [a]);
  invalid(report(row(a)), [a.id, a.id], [a]);
  invalid(report(row(a)), [a.id], [a, a]);
  invalid(report(row(a), b.id), [a.id], [a, b]);
  invalid(report(row(a) + `\n- ${absent} / ${a.sha256}`), [a.id], [a]);
  invalid(
    report(`- ${a.id} / ${a.sha256} / ${a.content.length} bytes`),
    [a.id],
    [a],
  );
  invalid(
    report(`- ${a.id} / ${a.sha256} / 9007199254740992 bytes`),
    [a.id],
    [a],
  );
  invalid(report(row(a)) + `\n\n## 证据索引\n${row(a)}`, [a.id], [a]);
  invalid(report("```markdown\n" + row(a) + "\n```"), [a.id], [a]);
  invalid(
    report("无证据。") + `\n\n\`\`\`markdown\n## 证据索引\n${row(a)}\n\`\`\``,
    [a.id],
    [a],
  );
});

test("report evidence metadata must describe the actual stored UTF-8 bytes", () => {
  const a = artifact();
  invalid(report(row(a)), [a.id], [{ ...a, content: "changed evidence" }]);
  invalid(report(row(a)), [a.id], [{ ...a, byteLength: a.byteLength + 1 }]);
});

test("report chapters and index share visible ATX headings outside fences and comments", () => {
  const a = artifact();
  for (const [opening, closing] of [
    ["```markdown", "```"],
    ["~~~markdown", "~~~"],
    ["````markdown", "````"],
    ["<!--", "-->"],
  ])
    invalid(hiddenChapters(row(a), opening!, closing!), [a.id], [a]);
  invalid(report(row(a)).replace("## 时间线", "时间线"), [a.id], [a]);
  invalid(report(row(a)).replace("## 时间线", "## 时间线###"), [a.id], [a]);
  invalid(hiddenChapters(row(a), "````markdown", "```"), [a.id], [a]);
  validateReportEvidence(explainedReport(row(a)), [a.id], [a]);
  validateReportEvidence(
    "```markdown\n<!-- literal comment inside code\n## 证据索引\n```\n" +
      "~~~markdown\n## 问题摘要\n~~~\n" +
      "<!--\n## 证据索引\n-->\n" +
      report(row(a)),
    [a.id],
    [a],
  );
  validateReportEvidence(
    report(row(a)).replace("## 时间线", "## 时间线 <!-- scope note -->"),
    [a.id],
    [a],
  );
});

async function fixture(t: TestContext) {
  const db = new Database(":memory:");
  const repo = new Repository(db),
    vault = new Vault(repo);
  vault.initialize("Synthetic-report-integrity-password-429");
  const engine = new Engine(repo, vault, {} as Connectors);
  t.after(async () => {
    await engine.close();
    db.close();
  });
  const workflow: Workflow = {
    schemaVersion: "flowhub.workflow/v1",
    workflowId: "report-evidence-regression",
    name: "合成报告证据回归",
    description: "Only synthetic evidence; no Skill execution is claimed.",
    version: "1.0.0",
    environment: "staging",
    mode: "guided",
    tags: [],
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    bindings: {},
    nodes: [
      { id: "start", title: "开始", type: "input", config: {} },
      {
        id: "report",
        title: "宿主报告交接",
        type: "agent_task",
        config: {
          kind: "host_skill",
          skillRef: "synthetic-report-contract",
          instructions: "Submit actual Markdown with the fixed evidence index.",
          reportContractRef: "incident-report/v1",
          inputMappings: {},
          outputSchema: {
            type: "object",
            properties: {
              reportMarkdown: { type: "string" },
              evidenceRefs: { type: "array", items: { type: "string" } },
            },
            required: ["reportMarkdown", "evidenceRefs"],
            additionalProperties: false,
          },
        },
      },
      {
        id: "end",
        title: "结束",
        type: "end",
        config: {
          resultRef: { ref: { source: "node", nodeId: "report", pointer: "" } },
        },
      },
    ],
    edges: [
      { source: "start", target: "report", port: "next" },
      { source: "report", target: "end", port: "next" },
    ],
    budgets: {
      maxRunSeconds: 30,
      maxToolCalls: 4,
      maxNodeExecutions: 10,
      maxAgentCheckpoints: 4,
      maxOutputBytes: 262144,
      maxRows: 100,
      maxToolSeconds: 5,
      maxRetries: 0,
    },
  };
  engine.saveDraft(workflow, undefined, {});
  engine.publish(workflow.workflowId);
  const start = async () => {
    const run = engine.start({
      workflowId: workflow.workflowId,
      version: workflow.version,
      mode: "guided",
      inputs: {},
      idempotencyKey: crypto.randomUUID(),
    });
    return settle(engine, run.runId, "WAITING_AGENT");
  };
  return { engine, repo, start };
}

async function settle(engine: Engine, runId: string, expected: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const state = engine.status(runId);
    if (state.state === expected) return state;
    assert.ok(
      ["QUEUED", "RUNNING"].includes(state.state),
      JSON.stringify(state),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail("Timed out waiting for " + expected);
}

const submission = (
  state: Json,
  reportMarkdown: string,
  evidenceRefs: string[],
) => ({
  runId: state.runId,
  checkpointId: state.checkpoint.id,
  checkpointToken: state.checkpoint.token,
  expectedRevision: state.revision,
  idempotencyKey: crypto.randomUUID(),
  submission: {
    type: "agent_result",
    payload: { reportMarkdown, evidenceRefs },
  },
});

test("AGT-13 invalid report evidence leaves zero reports and a reusable checkpoint; valid retry stores verified bytes", async (t) => {
  const { engine, repo, start } = await fixture(t);
  const state = await start(),
    other = await start();
  const a = artifact(first, undefined, state.runId);
  const b = artifact(
    second,
    "second independent synthetic evidence",
    state.runId,
  );
  const c = artifact(foreign, "different run evidence", other.runId);
  const d = {
    ...artifact(expired, "expired synthetic evidence", state.runId),
    expiresAt: Date.now() - 1,
  };
  for (const evidence of [a, b, c, d])
    repo.insert("artifacts", evidence.id, evidence);
  const candidates = [
    { index: `- ${a.id} / ${"0".repeat(64)}`, refs: [a.id] },
    { index: `- ${a.id} / ${b.sha256}`, refs: [a.id] },
    {
      index: `- ${a.id} / ${a.sha256} / ${a.byteLength + 1} bytes`,
      refs: [a.id],
    },
    { index: `- ${absent} / ${a.sha256}`, refs: [absent] },
    { index: row(c), refs: [c.id] },
    { index: row(d), refs: [d.id] },
    { index: `${row(a)}\n${row(a)}`, refs: [a.id] },
    { index: a.id, refs: [a.id], body: "正文单独出现正确哈希 " + a.sha256 },
    { index: row(a), refs: [a.id], body: b.id },
    { index: row(a), refs: [a.id], body: `${a.id} / ${"0".repeat(64)}` },
    {
      index: row(a),
      refs: [a.id],
      body: `正文声明：${a.id} / ${a.sha256} / 9999 bytes。`,
    },
    {
      index: row(a),
      refs: [a.id],
      body: `正文声明：${a.id} / ${a.sha256} / not-bytes`,
    },
  ];
  for (const candidate of candidates) {
    assert.throws(
      () =>
        engine.advance(
          submission(
            state,
            report(candidate.index, candidate.body),
            candidate.refs,
          ),
        ),
      { code: "ARTIFACT_INVALID" },
    );
    const after = engine.status(state.runId);
    assert.equal(after.state, "WAITING_AGENT");
    assert.equal(after.revision, state.revision);
    assert.equal(after.checkpoint.id, state.checkpoint.id);
    assert.equal(after.checkpoint.token, state.checkpoint.token);
    assert.equal(repo.get("runs", state.runId).outputs.report, undefined);
    assert.equal(
      repo.all("artifacts").filter((item) => item.nodeId === "report").length,
      0,
    );
    assert.equal(
      repo
        .events(state.runId, 0, 100)
        .some((event) => event.type === "AGENT_RESULT_ACCEPTED"),
      false,
    );
  }
  const markdown = report(
    [row(a), row(b)].join("\n"),
    `正文声明：${a.id} / ${a.sha256} / ${a.byteLength} bytes。`,
  );
  engine.advance(submission(state, markdown, [a.id, b.id]));
  const done = await settle(engine, state.runId, "SUCCEEDED");
  const reports = repo
    .all("artifacts")
    .filter((item) => item.runId === done.runId && item.nodeId === "report");
  assert.equal(reports.length, 2);
  for (const result of reports) {
    assert.equal(result.sha256, hash(result.content));
    assert.equal(result.byteLength, Buffer.byteLength(result.content));
    assert.equal(result.verification.contentStored, true);
    assert.equal(result.verification.evidenceReferencesValidated, true);
    assert.equal(result.verification.skillExecution, "host_reported");
    assert.equal(result.verification.factualReview, "not_performed");
  }
  assert.equal(
    reports.find((item) => item.mimeType === "text/markdown")!.content,
    markdown,
  );
});

test("hidden report chapters reject atomically and the same checkpoint accepts visible chapters", async (t) => {
  const { engine, repo, start } = await fixture(t);
  const state = await start(),
    a = artifact(first, undefined, state.runId);
  repo.insert("artifacts", a.id, a);
  for (const [opening, closing] of [
    ["```markdown", "```"],
    ["~~~markdown", "~~~"],
    ["<!--", "-->"],
  ]) {
    assert.throws(
      () =>
        engine.advance(
          submission(state, hiddenChapters(row(a), opening!, closing!), [a.id]),
        ),
      { code: "ARTIFACT_INVALID" },
    );
    const after = engine.status(state.runId);
    assert.equal(after.state, "WAITING_AGENT");
    assert.equal(after.revision, state.revision);
    assert.equal(after.checkpoint.id, state.checkpoint.id);
    assert.equal(after.checkpoint.token, state.checkpoint.token);
    assert.equal(repo.get("runs", state.runId).outputs.report, undefined);
    assert.equal(
      repo.all("artifacts").filter((item) => item.nodeId === "report").length,
      0,
    );
    assert.equal(
      repo
        .events(state.runId, 0, 100)
        .some((event) => event.type === "AGENT_RESULT_ACCEPTED"),
      false,
    );
  }
  const markdown = explainedReport(row(a));
  engine.advance(submission(state, markdown, [a.id]));
  await settle(engine, state.runId, "SUCCEEDED");
  const reports = repo
    .all("artifacts")
    .filter((item) => item.nodeId === "report");
  assert.equal(reports.length, 2);
  assert.equal(
    reports.find((item) => item.mimeType === "text/markdown")!.content,
    markdown,
  );
  for (const result of reports) {
    assert.equal(result.verification.formatValidated, true);
    assert.equal(result.verification.evidenceReferencesValidated, true);
    assert.equal(result.verification.skillExecution, "host_reported");
    assert.equal(result.verification.factualReview, "not_performed");
  }
});
