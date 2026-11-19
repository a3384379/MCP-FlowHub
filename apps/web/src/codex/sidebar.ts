import { App } from "@modelcontextprotocol/ext-apps";
import styles from "./sidebar.css?raw";

type WorkflowSummary = { workflowId: string; name: string; environment: string; version: string | null };
type WorkflowList = { items: WorkflowSummary[]; hasMore: boolean };
type Issue = { code: string; message?: string; nodeId?: string };
type Draft = {
  revision: number;
  draft: { name: string; description: string; nodes: { id: string; title: string; type: string }[]; edges: { source: string; target: string }[] };
  issues: Issue[];
};
type Suite = { suiteId: string; suiteRevision: number; caseCount: number; gaps: Issue[] };
type TestReport = {
  status: string;
  stale: boolean;
  summary?: { passed: number; failed: number; uncovered: number; total: number };
  gaps: Issue[];
  cases: { name: string; status: string; errorCode?: string; assertions: { passed: boolean }[] }[];
};
type Capability = {
  name?: string;
  displayName?: string;
  summary?: string;
  description?: string;
  executor?: string;
  stale?: boolean;
  presentation?: { displayName?: string; summary?: string };
  discovery?: { presentation?: { displayName?: string; summary?: string } };
};
type SidebarTool = "workflow_draft_get" | "workflow_draft_validate" | "workflow_test_generate" |
  "workflow_test_run" | "workflow_test_status" | "capability_search";

const app = new App({ name: "FlowHub", version: document.body.dataset.version! },
  { availableDisplayModes: ["fullscreen"] }, { autoResize: false, strict: true });
const style = document.createElement("style");
style.textContent = styles;
document.head.append(style);
document.body.innerHTML = `
<header>
  <div class="brand"><span aria-hidden="true">F</span><h1>FlowHub</h1></div>
  <nav aria-label="工作区">
    <button id="workflows-tab" aria-current="page">工作流</button>
    <button id="capabilities-tab">能力目录</button>
  </nav>
  <div class="management-entry">
    <a id="open-web" target="_blank" rel="noopener noreferrer">打开完整管理页 ↗</a>
    <button id="copy-web" type="button">复制本机地址</button>
  </div>
</header>
<div id="management-feedback" hidden>
  <p id="management-status" role="status"></p>
  <label id="management-address" hidden>本机地址 <input id="workspace-url" readonly></label>
</div>
<div id="connection" role="status">正在连接 FlowHub…</div>
<button id="retry" hidden>重试连接</button>
<main id="workflows" hidden>
  <aside aria-label="工作流列表">
    <div class="section-heading"><h2>工作流库</h2><button id="reload" aria-label="刷新工作流">刷新</button></div>
    <label for="workflow-filter">筛选工作流</label>
    <input id="workflow-filter" type="search" placeholder="搜索名称或 ID">
    <div id="workflow-list"></div>
    <form id="by-id">
      <label for="workflow-id">按 ID 打开草稿</label>
      <div class="actions"><input id="workflow-id" maxlength="256" required><button>打开</button></div>
    </form>
  </aside>
  <section id="detail" aria-label="草稿详情">
    <p id="draft-message" role="status">选择工作流查看草稿。</p>
    <div id="draft-body" hidden>
      <div class="section-heading"><h2 id="draft-name"></h2><span id="draft-revision" class="badge"></span></div>
      <p id="draft-description"></p>
      <h3>流程节点</h3>
      <ol id="nodes"></ol>
      <div class="card">
        <h3>校验与自测</h3>
        <div class="actions">
          <button id="validate">校验结构</button>
          <button id="generate">生成用例</button>
          <button id="run" class="primary" disabled>运行 Mock 自测</button>
        </div>
        <p id="test-summary" role="status"></p>
        <button id="refresh-test" hidden>刷新自测结果</button>
        <ul id="issues"></ul>
        <ul id="cases"></ul>
      </div>
    </div>
  </section>
</main>
<main id="capabilities" hidden>
  <h2>能力目录</h2>
  <form id="capability-search" class="actions">
    <label for="kind">能力类型</label>
    <select id="kind"><option value="mcp_tool">MCP 工具</option><option value="mcp_server">MCP 服务</option><option value="skill">Skills</option><option value="plugin">插件</option></select>
    <label for="cap-query">搜索能力</label>
    <input id="cap-query" type="search" maxlength="2000" placeholder="搜索名称或用途">
    <button>搜索</button>
  </form>
  <p id="cap-message" role="status"></p>
  <ul id="cap-list"></ul>
  <button id="more" hidden>加载更多</button>
</main>`;

function element<T extends HTMLElement = HTMLElement>(id: string) {
  return document.getElementById(id)! as T;
}
function row(text: string) {
  const item = document.createElement("li");
  item.textContent = text;
  return item;
}

const connected = element("connection");
const retry = element<HTMLButtonElement>("retry");
const fallback = element<HTMLAnchorElement>("open-web");
fallback.href = document.body.dataset.workspace!;
const workspaceUrl = element<HTMLInputElement>("workspace-url");
workspaceUrl.value = fallback.href;
workspaceUrl.addEventListener("focus", () => workspaceUrl.select());
function managementFeedback(text: string, showAddress = false) {
  element("management-feedback").hidden = false;
  element("management-status").textContent = text;
  element("management-address").hidden = !showAddress;
}
element("copy-web").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(fallback.href);
    managementFeedback("已复制本机地址。");
  } catch {
    managementFeedback("请复制本机地址，在浏览器打开。", true);
    workspaceUrl.focus();
  }
});
fallback.addEventListener("click", async event => {
  if (!app.getHostCapabilities()?.openLinks) {
    managementFeedback("已尝试在浏览器打开，可手动访问本机地址。", true);
    return;
  }
  event.preventDefault();
  try {
    if ((await app.openLink({ url: fallback.href })).isError) throw Error();
    managementFeedback("已请求打开管理页，请查看 Codex 标签页或系统浏览器。");
  } catch {
    managementFeedback("Codex 未打开管理页。请复制本机地址，在浏览器打开。", true);
  }
});

const environments: Record<string, string> = { production: "生产", staging: "试运行", test: "测试" };
const nodeTypes: Record<string, string> = {
  input: "输入", mcp_tool: "MCP 工具", agent_task: "Codex 任务",
  condition: "条件分支", report_template: "模板报告", end: "结束",
};
const testStates: Record<string, string> = {
  QUEUED: "排队", RUNNING: "运行中", SUCCEEDED: "通过", FAILED: "失败", PARTIAL: "部分覆盖",
  INTERRUPTED: "已中断", CANCELLED: "已取消", PASSED: "通过", UNCOVERED: "未覆盖", NOT_RUN: "未运行",
};
let workspace: WorkflowList = { items: [], hasMore: false };
let showingHelp = false;
let openedWorkspace = false;
let initialized = false;
let activeTab = "workflows";

async function call<T>(name: SidebarTool, args: Record<string, unknown>) {
  const response = await app.callServerTool({ name, arguments: args });
  const data = response.structuredContent as { error?: { code: string; message: string } } | undefined;
  if (response.isError || data?.error) {
    throw new Error(data?.error ? data.error.code + " · " + data.error.message : "MCP 工具调用失败。");
  }
  if (!data) throw new Error("FlowHub 未返回结构化结果。");
  return data as T;
}
function message(error: unknown) {
  return error instanceof Error ? error.message : "FlowHub 请求失败。";
}
function showTab(tab: string) {
  activeTab = tab;
  for (const name of ["workflows", "capabilities"]) {
    element(name).hidden = name !== tab;
    const button = element(name + "-tab");
    if (name === tab) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
}
function receive(result: { structuredContent?: unknown; _meta?: Record<string, unknown> }) {
  const content = result.structuredContent as { opened?: boolean; excerpts?: unknown } | undefined;
  const list = result._meta?.["flowhub/workflows"] as WorkflowList | undefined;
  if (content?.opened === true && Array.isArray(list?.items)) {
    workspace = list;
    renderWorkflows();
    openedWorkspace = true;
    connected.hidden = true;
    retry.hidden = true;
    showTab(activeTab);
  } else if (!openedWorkspace && Array.isArray(content?.excerpts)) {
    showingHelp = true;
    connected.textContent = "帮助查询结果已返回对话。";
    retry.hidden = true;
  }
}
async function reloadWorkflows() {
  const response = await app.callServerTool({ name: "project_help_search", arguments: {} });
  if (response.isError || !response._meta?.["flowhub/workflows"]) {
    throw new Error("未能读取工作流，请检查 FlowHub 后台与当前插件版本。");
  }
  receive(response);
}
app.ontoolresult = receive;
for (const name of ["workflows", "capabilities"]) {
  element(name + "-tab").addEventListener("click", () => {
    if (!openedWorkspace) return;
    showTab(name);
    if (name === "capabilities" && !capFilter) void searchCapabilities();
  });
}
const refresh = element<HTMLButtonElement>("reload");
refresh.addEventListener("click", async () => {
  refresh.disabled = true;
  try {
    await reloadWorkflows();
    if (selectedId) await selectWorkflow(selectedId);
  } catch (error) {
    element("draft-message").textContent = message(error);
  } finally {
    refresh.disabled = false;
  }
});

const filter = element<HTMLInputElement>("workflow-filter");
const workflowList = element("workflow-list");
const byId = element<HTMLFormElement>("by-id");
const workflowId = element<HTMLInputElement>("workflow-id");
let selectedId = "";
function renderWorkflows() {
  const query = filter.value.trim().toLowerCase();
  const rows = workspace.items.filter(item => [item.name, item.workflowId]
    .some(text => text.toLowerCase().includes(query)));
  workflowList.replaceChildren();
  for (const item of rows) {
    const button = document.createElement("button");
    button.className = "workflow";
    button.setAttribute("aria-pressed", String(item.workflowId === selectedId));
    const name = document.createElement("strong");
    name.textContent = item.name;
    const info = document.createElement("span");
    info.textContent = [environments[item.environment] ?? item.environment, item.version ? "v" + item.version : "草稿"].join(" · ");
    button.append(name, info);
    button.addEventListener("click", () => void selectWorkflow(item.workflowId));
    workflowList.append(button);
  }
  if (!rows.length) workflowList.textContent = query ? "未找到匹配工作流。" : "暂无工作流。";
  if (workspace.hasMore) workflowList.append("显示最近 100 条，可按 ID 打开其他草稿。");
}
filter.addEventListener("input", renderWorkflows);
byId.addEventListener("submit", event => {
  event.preventDefault();
  if (workflowId.value.trim()) void selectWorkflow(workflowId.value.trim());
});

const draftBody = element("draft-body");
const draftMessage = element("draft-message");
const validateButton = element<HTMLButtonElement>("validate");
const generateButton = element<HTMLButtonElement>("generate");
const runButton = element<HTMLButtonElement>("run");
const refreshTest = element<HTMLButtonElement>("refresh-test");
const testSummary = element("test-summary");
const issues = element("issues");
const cases = element("cases");
type Selection = {
  id: string; revision: number; suite?: Suite; testRunId?: string;
  generateKey?: string; runKey?: string;
};
let selection: Selection | undefined;
let selectionRequest = 0;
function operationKey() {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
}
async function selectWorkflow(id: string) {
  const request = ++selectionRequest;
  selectedId = id;
  selection = undefined;
  renderWorkflows();
  draftBody.hidden = true;
  draftMessage.textContent = "正在读取草稿…";
  try {
    const data = await call<Draft>("workflow_draft_get", { workflowId: id });
    if (request !== selectionRequest) return;
    const draft = data.draft;
    selection = { id, revision: data.revision };
    element("draft-name").textContent = draft.name;
    element("draft-revision").textContent = "草稿 r" + data.revision;
    element("draft-description").textContent = draft.description;
    element("nodes").replaceChildren(...draft.nodes.map(node => row(
      node.title + " · " + (nodeTypes[node.type] ?? node.type) +
      draft.edges.filter(edge => edge.source === node.id).map(edge =>
        " → " + (draft.nodes.find(target => target.id === edge.target)?.title ?? edge.target)).join(""),
    )));
    issues.replaceChildren(...data.issues.map(formatIssue));
    cases.replaceChildren();
    testSummary.textContent = "";
    draftMessage.textContent = "";
    refreshTest.hidden = true;
    setTestBusy(false);
    draftBody.hidden = false;
  } catch (error) {
    if (request === selectionRequest) draftMessage.textContent = message(error);
  }
}
function formatIssue(issue: Issue | string) {
  return row(typeof issue === "string" ? issue : [issue.nodeId, issue.code, issue.message].filter(Boolean).join(" · "));
}
function setTestBusy(busy: boolean) {
  validateButton.disabled = generateButton.disabled = refreshTest.disabled = busy;
  runButton.disabled = busy || !selection?.suite;
}
async function action(work: (current: Selection) => Promise<void>) {
  const current = selection;
  if (!current) return;
  setTestBusy(true);
  try {
    await work(current);
  } catch (error) {
    if (selection === current) testSummary.textContent = message(error);
  } finally {
    if (selection === current) setTestBusy(false);
  }
}
validateButton.addEventListener("click", () => void action(async current => {
  testSummary.textContent = "正在校验草稿…";
  const result = await call<{ valid: boolean; issues: Issue[]; warnings: Issue[] }>("workflow_draft_validate", {
    workflowId: current.id, expectedRevision: current.revision, level: "structure",
  });
  if (selection !== current) return;
  testSummary.textContent = result.valid ? "草稿结构校验通过。" : "草稿存在结构问题。";
  issues.replaceChildren(...[...result.issues, ...result.warnings].map(formatIssue));
}));
generateButton.addEventListener("click", () => void action(async current => {
  testSummary.textContent = "正在生成确定性用例…";
  const suite = await call<Suite>("workflow_test_generate", {
    workflowId: current.id, expectedRevision: current.revision, strategy: "deterministic",
    idempotencyKey: current.generateKey ??= operationKey(),
  });
  current.generateKey = undefined;
  if (selection !== current) return;
  current.suite = suite;
  current.testRunId = current.runKey = undefined;
  refreshTest.hidden = true;
  testSummary.textContent = `已生成 ${suite.caseCount} 个用例，${suite.gaps.length} 项覆盖缺口。`;
  cases.replaceChildren();
  issues.replaceChildren(...suite.gaps.map(formatIssue));
}));
runButton.addEventListener("click", () => void action(async current => {
  if (!current.suite) return;
  testSummary.textContent = "正在提交 Mock 自测…";
  const accepted = await call<{ testRunId: string }>("workflow_test_run", {
    suiteId: current.suite.suiteId, expectedSuiteRevision: current.suite.suiteRevision,
    mode: "mock", idempotencyKey: current.runKey ??= operationKey(),
  });
  current.runKey = undefined;
  current.testRunId = accepted.testRunId;
  await readTest(current);
}));
refreshTest.addEventListener("click", () => void action(readTest));

async function readTest(current: Selection) {
  for (let attempt = 0; attempt < 30 && selection === current; attempt++) {
    refreshTest.hidden = false;
    const report = await call<TestReport>("workflow_test_status", { testRunId: current.testRunId });
    if (selection !== current) return;
    const summary = report.summary;
    testSummary.textContent = [
      "Mock 自测" + (testStates[report.status] ?? report.status),
      summary && `通过 ${summary.passed} / ${summary.total}，失败 ${summary.failed}，未覆盖 ${summary.uncovered}`,
      report.stale && "测试基线已过期",
    ].filter(Boolean).join(" · ");
    issues.replaceChildren(...report.gaps.map(formatIssue));
    cases.replaceChildren(...report.cases.map(test => row(
      [test.name, testStates[test.status] ?? test.status,
        `断言 ${test.assertions.filter(item => item.passed).length}/${test.assertions.length}`, test.errorCode].filter(Boolean).join(" · "),
    )));
    if (!["QUEUED", "RUNNING"].includes(report.status)) return;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
}

const capForm = element<HTMLFormElement>("capability-search");
const capQuery = element<HTMLInputElement>("cap-query");
const kind = element<HTMLSelectElement>("kind");
const capList = element("cap-list");
const capMessage = element("cap-message");
const more = element<HTMLButtonElement>("more");
let capFilter: { query: string; kind: string } | undefined;
let nextCursor: string | null = null;
let searchRequest = 0;
async function searchCapabilities(moreResults = false) {
  const request = ++searchRequest;
  const args = moreResults ? capFilter! : { kind: kind.value, query: capQuery.value.trim() };
  if (!moreResults) {
    capFilter = args;
    capList.replaceChildren();
  }
  more.hidden = true;
  capMessage.textContent = "正在读取能力目录…";
  try {
    const data = await call<{ items: Capability[]; nextCursor: string | null }>("capability_search", {
      ...args, limit: 25, ...(moreResults ? { cursor: nextCursor } : {}),
    });
    if (request !== searchRequest) return;
    nextCursor = data.nextCursor;
    for (const capability of data.items) {
      const display = capability.discovery?.presentation ?? capability.presentation;
      const name = display?.displayName || capability.displayName || capability.name || "未命名能力";
      const details = display?.summary || capability.summary || capability.description;
      const tile = row("");
      const title = document.createElement("strong");
      title.textContent = name;
      tile.append(title);
      if (details) {
        const description = document.createElement("p");
        description.textContent = details;
        tile.append(description);
      }
      if (capability.stale) tile.append("来源待刷新");
      capList.append(tile);
    }
    capMessage.textContent = capList.childElementCount ? "" : "该分类暂无匹配的能力。";
    more.hidden = !nextCursor;
  } catch (error) {
    if (request === searchRequest) {
      capMessage.textContent = message(error);
      if (moreResults && nextCursor) more.hidden = false;
    }
  }
}
capForm.addEventListener("submit", event => { event.preventDefault(); void searchCapabilities(); });
kind.addEventListener("change", () => void searchCapabilities());
more.addEventListener("click", () => { if (nextCursor && capFilter) void searchCapabilities(true); });

async function connect() {
  connected.textContent = "正在连接 FlowHub…";
  retry.hidden = true;
  try {
    if (!initialized) {
      await app.connect();
      initialized = true;
      setTimeout(() => {
        if (!openedWorkspace && !showingHelp) {
          connected.textContent = "等待 FlowHub 工作区数据。";
          retry.hidden = false;
        }
      }, 2500);
    } else {
      await reloadWorkflows();
    }
  } catch (error) {
    connected.textContent = message(error);
    retry.hidden = false;
  }
}
retry.addEventListener("click", () => void connect());
void connect();
