import React, {
  useEffect,
  useState,
  useCallback,
  useRef,
  createContext,
  useContext,
} from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./style.css";
import incidentTemplateSource from "../../../examples/incident-staging.json?raw";
import exampleBindingSource from "../../../examples/bindings.example.json?raw";
import { FloatingAssistant } from "./features/assistant/FloatingAssistant";
import { ModelsPage } from "./features/models/ModelsPage";
import { TestingPanel } from "./features/testing/TestingPanel";
import { RunAnalysisControl } from "./features/workflows/RunAnalysisControl";
import {
  buildWorkflowSvg,
  workflowNodeWidth,
} from "./features/workflows/workflow-svg";
import { WorkflowSvgPreview } from "./features/workflows/WorkflowSvgPreview";
import {
  minimumWorkflowZoom,
  WorkflowViewport,
} from "./features/workflows/WorkflowViewport";
import { RunArtifacts } from "./features/runs/RunArtifacts";
import { useRunDetail } from "./features/runs/useRunDetail";
import { RunBusinessOutcome, RunContinuation } from "./features/runs/RunOutcome";
import { ExecutionEvidence, ExecutionRequirements } from "./features/workflows/ExecutionRequirements";
import { workflowRequirements } from "../../../packages/contracts/src/workflow-requirements";
import { CapabilityPicker } from "./features/workflows/CapabilityPicker";
import { DeletedWorkflowNotice } from "./features/workflows/DeletedWorkflowNotice";
import { initializeEvents, subscribeEvents } from "./shared/v2";
import { inCodexWorkspace, readCodexLaunch, workspaceDialog, workspaceHref, workspacePath } from "./shared/codex-workspace";
import { mergeDraft } from "./shared/draft-merge";
import { download } from "./shared/download";
import { mcpOutputSchema } from "../../../packages/contracts/src/mcp-output-schema";
import { DiscoveryPage } from "./features/discovery/DiscoveryPage";
import type { DiscoveryDestination } from "./features/discovery/issue-actions";
import { SettingsIntegration } from "./SettingsIntegration";
import { AppSidebar, NavigationIcon } from "./features/navigation/AppSidebar";
import { navigationForPage, navigationLabel, normalizeWorkspacePath, resourceBindingsPath } from "./features/navigation/navigation";
import {
  ConnectionForm,
  BindingForm,
  BindingVerificationForm,
  BindingVerificationStatus,
  bindingProbeDefaults,
} from "./ConnectionBindingForms";
type J = any;
const compactEditorMedia = "(max-width: 1300px)";
const exampleBindingIds = new Set<string>(
  JSON.parse(exampleBindingSource).bindings.map((binding: { bindingRef: string }) => binding.bindingRef),
);
const retentionScopeKeys = ["runs", "resultRuns", "checkpoints", "artifacts", "assistantResultTasks", "assistantResultMessages", "assistantLegacyResultMessages", "assistantResultToolCalls", "assistantResultSessions", "assistantTasks", "assistantMessages", "assistantToolCalls", "assistantSessions", "workflowTestResultRuns", "workflowTestRuns", "applicationResultEvents", "applicationEvents"];
const retentionPreview = (value: J) => ({...value, ...Object.fromEntries(retentionScopeKeys.map(key=>[key,Array.isArray(value[key])?value[key]:[]]))});
const editorTextVersions = new WeakMap<
  Map<string, string>,
  Map<string, number>
>();
function textVersions(cache: Map<string, string>) {
  let versions = editorTextVersions.get(cache);
  if (!versions) {
    versions = new Map();
    editorTextVersions.set(cache, versions);
  }
  return versions;
}
function cacheText(cache: Map<string, string>, key: string, text: string) {
  cache.set(key, text);
  const versions = textVersions(cache);
  versions.set(key, (versions.get(key) ?? 0) + 1);
}
const EditorTextContext = createContext<{
  cache: Map<string, string>;
  scope: string;
} | null>(null);
let csrf = "";
class UiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 422,
    public details?: J,
    public path?: string,
  ) {
    super(code + "：" + message);
  }
}
let openingSession: Promise<J> | undefined;
let codexLaunch = readCodexLaunch();
function openLocalSession() {
  if (inCodexWorkspace && !codexLaunch)
    return Promise.reject(new UiError("AUTH_REQUIRED", "请从 Codex 侧栏重新打开 FlowHub。", 401));
  openingSession ??= fetch(inCodexWorkspace ? "/api/v1/auth/codex-session" : "/api/v1/auth/local-session", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-FlowHub-Local": "1" },
    body: JSON.stringify(inCodexWorkspace && codexLaunch ? { ticket: codexLaunch } : {}),
  })
    .then(async response => {
      const value = await response.json();
      if (!response.ok)
        throw new UiError(
          value.error?.code ?? "SERVICE_UNAVAILABLE",
          inCodexWorkspace ? "请从 Codex 侧栏重新打开 FlowHub。" : "无法连接本机 FlowHub。",
          response.status,
        );
      if (inCodexWorkspace) {
        codexLaunch = undefined;
        const check = await fetch("/api/v1/auth/session");
        if (!check.ok) throw new UiError("AUTH_REQUIRED", "Codex 未保留本机工作区会话。", check.status);
      }
      csrf = value.data.csrf;
      return value.data;
    })
    .finally(() => { openingSession = undefined; });
  return openingSession;
}

let sessionRecovery: Promise<{ session: J; issued: boolean } | undefined> | undefined;
function recoverLocalSession() {
  sessionRecovery ??= fetch("/api/v1/auth/session")
    .then(async check => {
      if (check.status === 401) return { session: await openLocalSession(), issued: true };
      if (check.ok) return { session: (await check.json()).data, issued: false };
      return undefined;
    })
    .catch(() => undefined)
    .finally(() => { sessionRecovery = undefined; });
  return sessionRecovery;
}

async function apiResponse(
  path: string,
  method = "GET",
  body?: J,
  revision?: number,
  signal?: AbortSignal,
): Promise<Response> {
  const sendRequest = () => fetch(path.startsWith("/api/v2/") ? path : "/api/v1" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      ...(revision !== undefined ? { "If-Match": String(revision) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    ...(signal ? { signal } : {}),
  });
  let response = await sendRequest();
  const staleCsrf = response.status === 403 &&
    (await response.clone().json().catch(() => null))?.error?.code === "CSRF_DENIED";
  if ((response.status === 401 || staleCsrf) && !path.startsWith("/auth/")) {
    const recovered = await recoverLocalSession();
    if (recovered && (recovered.issued || staleCsrf)) {
      csrf = recovered.session.csrf;
      window.dispatchEvent(new Event("flowhub-session-restored"));
      if (["GET", "HEAD"].includes(method)) {
        response = await sendRequest();
      }
      else throw new UiError("AUTH_REQUIRED", "本机连接已恢复，请重试刚才的操作。", 401);
    }
  }
  if (!response.ok) {
    const value = await response.json().catch(() => null);
    throw new UiError(
      String(value?.error?.code ?? response.status),
      value?.error?.message ?? "请求失败",
      response.status,
      value?.error?.details,
      path,
    );
  }
  return response;
}

async function api(
  path: string,
  method = "GET",
  body?: J,
  revision?: number,
  signal?: AbortSignal,
  withMeta = false,
): Promise<J> {
  const value = await (await apiResponse(path, method, body, revision, signal)).json();
  return withMeta ? value : value.data;
}
const readRunDetail = (path: string, signal: AbortSignal) =>
  api(path, "GET", undefined, undefined, signal);
const pretty = (v: J) => JSON.stringify(v, null, 2);
const listItems = (result: J): J[] => result.data;
const runPage = (result: J): { data: J[]; meta: { total: number } } => result;

function useWorkspaceList<T>(
  endpoint: string | null, initial: T, select: (result: J) => T, reportError: (message: string) => void,
) {
  const [items, setItems] = useState(initial);
  const currentEndpoint = useRef(endpoint);
  const generation = useRef(0);
  currentEndpoint.current = endpoint;
  const refresh = useCallback(async () => {
    const path = currentEndpoint.current;
    if (!path) return;
    const request = ++generation.current;
    const current = () => currentEndpoint.current === path && generation.current === request;
    try {
      const result = await api(path, "GET", undefined, undefined, undefined, true);
      if (current()) setItems(select(result));
    } catch (error) {
      if (current()) throw error;
    }
  }, [select]);
  useEffect(() => {
    void refresh().catch(error => reportError(error.message));
    return () => { generation.current++; };
  }, [endpoint, refresh, reportError]);
  return [items, refresh, setItems] as const;
}

const uid = () => crypto.randomUUID();
const isObject = (value: J) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
function assertWorkflowShape(workflow: J) {
  if (
    !isObject(workflow) ||
    typeof workflow.workflowId !== "string" ||
    typeof workflow.name !== "string" ||
    typeof workflow.description !== "string" ||
    typeof workflow.environment !== "string" ||
    typeof workflow.version !== "string" ||
    !isObject(workflow.inputSchema) ||
    !Array.isArray(workflow.nodes) ||
    !Array.isArray(workflow.edges) ||
    !isObject(workflow.bindings) ||
    !Object.values(workflow.bindings).every((ref) => typeof ref === "string") ||
    !workflow.nodes.every(
      (n: J) =>
        isObject(n) &&
        typeof n.id === "string" &&
        typeof n.title === "string" &&
        typeof n.type === "string" &&
        isObject(n.config),
    ) ||
    !workflow.edges.every(
      (e: J) =>
        isObject(e) &&
        typeof e.source === "string" &&
        typeof e.target === "string",
    )
  )
    throw new Error(
      "工作流定义必须包含 nodes、edges、bindings，节点配置必须为对象",
    );
  const mapping = (expression: J): boolean =>
    isObject(expression) &&
    (Object.hasOwn(expression, "value") ||
      (isObject(expression.ref) &&
        ["input", "node"].includes(expression.ref.source) &&
        typeof expression.ref.pointer === "string" &&
        (expression.ref.source !== "node" ||
          typeof expression.ref.nodeId === "string")));
  for (const node of workflow.nodes) {
    for (const field of ["argumentsMappings", "inputMappings"])
      if (
        node.config[field] !== undefined &&
        (!isObject(node.config[field]) ||
          !Object.values(node.config[field]).every(mapping))
      )
        throw new UiError(
          "INPUT_INVALID",
          "参数映射必须为常量或字段引用",
          422,
          {
            issues: [
              {
                code: "INPUT_INVALID",
                nodeId: node.id,
                pointer: "/nodes/" + node.id + "/config/" + field,
                message: "映射值不能为 null、数组或裸值",
              },
            ],
          },
        );
    if (node.type === "condition") {
      const condition = (expression: J, depth = 0): boolean =>
        depth < 16 &&
        isObject(expression) &&
        (expression.op === "eq"
          ? mapping(expression.left) && mapping(expression.right)
          : expression.op === "exists"
            ? mapping(expression.value)
            : ["and", "or"].includes(expression.op) &&
              Array.isArray(expression.args) &&
              expression.args.length > 0 &&
              expression.args.every((part: J) => condition(part, depth + 1)));
      if (!condition(node.config.expression))
        throw new Error("条件节点必须使用有效的有限条件 AST");
    }
  }
}
function createWorkflowTemplate(form: J) {
  const workflow = form.sourceWorkflow
    ? structuredClone(form.sourceWorkflow)
    : JSON.parse(incidentTemplateSource);
  workflow.workflowId = form.slug.trim();
  workflow.name = form.name.trim();
  workflow.description =
    form.description.trim() ||
    "新建草稿：请配置输入、节点与环境绑定后校验发布。";
  workflow.environment = form.environment;
  workflow.version = "1.0.0";
  workflow.bindings = {};
  workflow.tags = [];
  for (const n of workflow.nodes)
    if (n.type === "mcp_tool") {
      n.config.toolName = "unconfigured";
      n.config.toolSchemaHash = "placeholder:unconfigured";
    }
  if (!form.sourceWorkflow && form.template === "blank") {
    workflow.mode = "auto";
    workflow.inputSchema = {
      type: "object",
      properties: {},
      additionalProperties: false,
      examples: [{}],
    };
    workflow.nodes = workflow.nodes.filter((n: J) =>
      ["input", "end"].includes(n.id),
    );
    workflow.nodes[0].title = "接收输入";
    workflow.nodes[1].title = "返回输入并结束";
    workflow.nodes[1].config.resultRef = {
      ref: { source: "input", pointer: "" },
    };
    workflow.edges = [{ source: "input", target: "end", port: "next" }];
  } else if (!form.sourceWorkflow && form.template === "deterministic") {
    workflow.mode = "auto";
    workflow.nodes = workflow.nodes.filter((n: J) =>
      ["input", "log", "end"].includes(n.id),
    );
    workflow.nodes.find((n: J) => n.id === "end").config.resultRef = {
      ref: { source: "node", nodeId: "log", pointer: "" },
    };
    workflow.edges = [
      { source: "input", target: "log", port: "next" },
      { source: "log", target: "end", port: "next" },
    ];
  }
  return workflow;
}
const labels: Record<string, string> = {
  input: "接收输入",
  mcp_tool: "MCP 工具",
  agent_task: "Codex 任务",
  condition: "条件分支",
  report_template: "模板报告",
  end: "结束归档",
};
const glyph: Record<string, string> = {
  workflows: "▦",
  editor: "◇",
  connections: "⌘",
  runs: "◷",
  settings: "⚙",
  input: "↳",
  mcp_tool: "☁",
  agent_task: "✧",
  condition: "⑂",
  report_template: "▧",
  end: "◎",
};
const statusLabels: Record<string, string> = {
  SUCCEEDED: "已完成",
  WAITING_AGENT: "等待 Agent",
  BLOCKED: "已阻断",
  OUTCOME_UNKNOWN: "结果未知",
  FAILED: "失败",
  CANCELLED: "已取消",
  RUNNING: "执行中",
  QUEUED: "排队中",
  REJECTED: "已拒绝",
};
const nodeLabel = (n: J) => (
  <div className="node-label">
    <i>{glyph[n.type]}</i>
    <div>
      <small>{labels[n.type]}</small>
      <strong>{n.title}</strong>
      <span>
        {n.type === "mcp_tool"
          ? n.config.toolName
          : n.type === "agent_task"
            ? n.config.kind
            : "受控执行节点"}
      </span>
    </div>
  </div>
);
function Badge({
  children,
  tone = "blue",
}: {
  children: React.ReactNode;
  tone?: string;
}) {
  return <span className={"badge " + tone}>{children}</span>;
}
function JsonEditor({
  value,
  onChange,
  label = "JSON 配置",
  onValidityChange,
  validateValue,
  onDirty,
  textCache,
  cacheKey,
}: {
  value: J;
  onChange: (v: J) => boolean | Promise<boolean>;
  label?: string;
  onValidityChange?: (label: string, valid: boolean) => void;
  validateValue?: (v: J) => void;
  onDirty?: () => void;
  textCache?: Map<string, string>;
  cacheKey?: string;
}) {
  const key = cacheKey ?? label;
  const mounted = useRef(true);
  const [text, setText] = useState(textCache?.get(key) ?? pretty(value)),
    [error, setError] = useState(""),
    [pending, setPending] = useState(false);
  useEffect(() => {
    const cached = textCache?.get(key);
    setText(cached ?? pretty(value));
    try {
      if (cached !== undefined) validateValue?.(JSON.parse(cached));
      setError("");
      onValidityChange?.(key, true);
    } catch {
      setError("恢复了未应用的 JSON 文本，请修正后再保存");
      onValidityChange?.(key, false);
    }
  }, [value, key]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      onValidityChange?.(key, true);
    };
  }, [key, onValidityChange]);
  return (
    <label className="field">
      {label}
      <textarea
        aria-label={label}
        spellCheck={false}
        disabled={pending}
        value={text}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (textCache) cacheText(textCache, key, next);
          onDirty?.();
          try {
            const parsed = JSON.parse(next);
            validateValue?.(parsed);
            setError("");
            onValidityChange?.(key, true);
          } catch (e) {
            setError(
              e instanceof SyntaxError
                ? "JSON 格式错误，尚未应用"
                : (e as Error).message,
            );
            onValidityChange?.(key, false);
          }
        }}
        onBlur={async () => {
          if (text === pretty(value) && !textCache?.has(key)) return;
          try {
            const v = JSON.parse(text);
            validateValue?.(v);
            const version = textCache
              ? textVersions(textCache).get(key)
              : undefined;
            const result = onChange(v);
            let applied: boolean;
            if (typeof result !== "boolean") {
              setPending(true);
              onValidityChange?.(key, false);
              applied = await result;
            } else applied = result;
            if (applied !== true)
              throw new Error("本次校验已过期，JSON 文本尚未应用，请重新校验");
            if (
              textCache &&
              (textVersions(textCache).get(key) !== version ||
                textCache.get(key) !== text)
            )
              return;
            textCache?.delete(key);
            if (mounted.current) {
              setError("");
              onValidityChange?.(key, true);
            }
          } catch (e) {
            if (mounted.current) {
              setError(
                e instanceof SyntaxError
                  ? "JSON 格式错误，尚未应用"
                  : (e as Error).message,
              );
              onValidityChange?.(key, false);
            }
          } finally {
            if (mounted.current) setPending(false);
          }
        }}
      />
      {pending && <small role="status">正在校验 JSON，完成后可继续保存</small>}
      {error && <small className="error">{error}</small>}
    </label>
  );
}
function App() {
  const [navigationOpen, setNavigationOpen] = useState(false);
  const [path, setPath] = useState(() => normalizeWorkspacePath(workspacePath())),
    [session, setSession] = useState<J>(null),
    [auth, setAuth] = useState<J>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false);
  useEffect(() => { setNavigationOpen(false); }, [path]);
  const page = path === resourceBindingsPath ? "resource-bindings" : path.includes("/editor")
    ? "editor"
    : path.split("/")[1] === "tools"
      ? "connections"
      : (path.split("/")[1] ?? "workflows");
  const runListVisible = page === "runs" && !/^\/runs\/[^/]+$/.test(path);
  const [assistantReferencesOpen, setAssistantReferencesOpen] = useState(false);
  const [runs, setRuns] = useState<J[]>([]);
  const deletedWorkflows = useRef(new Set<string>());
  const needsWorkflows = ["workflows", "settings"].includes(page) || assistantReferencesOpen;
  const needsWorkflowsRef = useRef(needsWorkflows);
  needsWorkflowsRef.current = needsWorkflows;
  const visibleWorkflows = useCallback((result: J): J[] =>
    result.data.filter((workflow: J) => !deletedWorkflows.current.has(workflow.id)), []);
  const [workflows, refreshWorkflows, setWorkflows] = useWorkspaceList(
    session && needsWorkflows ? "/workflows" : null,
    [], visibleWorkflows, setError,
  );
  const [connections, refreshConnections] = useWorkspaceList(
    session && ["workflows", "connections", "resource-bindings"].includes(page) ? "/connections" : null,
    [], listItems, setError,
  );
  const [bindings, refreshBindings] = useWorkspaceList(
    session && ["editor", "resource-bindings"].includes(page) ? "/bindings" : null, [], listItems, setError,
  );
  const [tools, refreshTools] = useWorkspaceList(
    session && ["editor", "connections", "resource-bindings"].includes(page) ? "/tools" : null, [], listItems, setError,
  );
  const deletionPendingRef = useRef(false);
  const [deletionPending,setDeletionPending] = useState(false);
  const [credentials, setCredentials] = useState<J[]>([]);
  const [runListState, setRunListState] = useState<"pending" | "ready" | { message: string }>("pending");
  const [runsMeta, setRunsMeta] = useState<J>(null),
    [runFilter, setRunFilter] = useState("");
  const useVisibleRuns = runListVisible && !runFilter;
  const runReferencePath = assistantReferencesOpen && !useVisibleRuns ? "/runs?limit=50"
    : page === "workflows" ? "/runs?limit=1" : null;
  const [recentRuns, refreshRecentRuns] = useWorkspaceList(
    session ? runReferencePath : null, { data: [], meta: { total: 0 } }, runPage, setError,
  );
  const runFilterRef = useRef(runFilter),
    runListRequest = useRef(0);
  runFilterRef.current = runFilter;
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState<J>(null),
    [draft, setDraft] = useState<J>(null),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [previewArtifactId, setPreviewArtifactId] = useState<string | null>(null);
  const runDetailId = /^\/runs\/[^/]+$/.test(path) ? path.split("/")[2]! : null;
  const { run, issue: currentRunIssue, refresh: refreshRunDetail } = useRunDetail(
    session ? runDetailId : null,
    readRunDetail,
  );
  useEffect(() => setPreviewArtifactId(null), [runDetailId]);
  const publishReviewRef=useRef(modal);publishReviewRef.current=modal;
  const [failure, setFailure] = useState<J>(null),
    [conflict, setConflict] = useState<J>(null);
  const closeModal = () => { if(!deletionPendingRef.current) setModal(null); };
  const serverDraftBase=useRef<J>(null),conflictRef=useRef<J>(conflict),remoteSyncRequest=useRef(0),pendingRemoteEvent=useRef<J>(null),syncRemoteRef=useRef<(event:J)=>Promise<void>>(async()=>{});
  conflictRef.current=conflict;
  const pathRef = useRef(path),
    dirtyRef = useRef(dirty),
    draftRef = useRef<J>(draft);
  pathRef.current = path;
  dirtyRef.current = dirty;
  draftRef.current = draft;
  const historyIndex = useRef(0),
    restoringHistory = useRef(false);
  const routeGeneration = useRef(0);
  const undoStack = useRef<J[]>([]),
    redoStack = useRef<J[]>([]);
  const [undoCount, setUndoCount] = useState(0),
    [redoCount, setRedoCount] = useState(0);
  const [compactEditor, setCompactEditor] = useState(
    () => window.matchMedia(compactEditorMedia).matches,
  );
  const [editorOverlay, setEditorOverlay] = useState<"palette" | "inspector" | null>(null);
  const [dockedPanels, setDockedPanels] = useState({ palette: true, inspector: true });
  const paletteOpen = compactEditor ? editorOverlay === "palette" : dockedPanels.palette;
  const inspectorOpen = compactEditor ? editorOverlay === "inspector" : dockedPanels.inspector;
  const showEditorPanel = (panel: "palette" | "inspector", open: boolean) => {
    if (compactEditor) setEditorOverlay(open ? panel : null);
    else setDockedPanels((previous) => ({ ...previous, [panel]: open }));
  };
  useEffect(() => {
    const media = window.matchMedia(compactEditorMedia);
    const resize = () => {
      setCompactEditor(media.matches);
      setEditorOverlay(null);
    };
    media.addEventListener("change", resize);
    return () => media.removeEventListener("change", resize);
  }, []);
  useEffect(() => setEditorOverlay(null), [draft?.id]);
  const [assistantOpenRequest,setAssistantOpenRequest]=useState(0);
  const openAssistant=()=>setAssistantOpenRequest(value=>value+1);
  useEffect(() => {
    if (!["/assistant", "/editor"].includes(path) || !session) return;
    history.replaceState(history.state, "", workspaceHref("/workflows"));
    setPath("/workflows");
    if (path === "/assistant") setAssistantOpenRequest(value => value + 1);
  }, [path, session]);
  useEffect(() => {
    if (!session) return;
    let alive=true;
    const changed=()=>{void api("/auth/state").then(value=>{if(alive)setAuth(value);}).catch(()=>{});};
    window.addEventListener("flowhub-credentials-changed",changed);
    return ()=>{alive=false;window.removeEventListener("flowhub-credentials-changed",changed);};
  },[session]);
  const savingRef=useRef(false);
  const [changedByAI,setChangedByAI]=useState<string[]>([]);
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const modalRef = useRef<HTMLElement>(null);
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([]);
  const editorRef = useRef<J>(null);
  editorRef.current = draft
    ? {
        ...draft,
        draft: {
          ...draft.draft,
          workflowId: draft.id,
          edges: edges.map((edge) => ({
            source: edge.source,
            target: edge.target,
            port: edge.data?.port ?? "next",
          })),
        },
        layout: Object.fromEntries(
          nodes.map((node) => [node.id, { ...node.position }]),
        ),
      }
    : null;
  const invalidJson = useRef(new Set<string>());
  const jsonTextCache = useRef(new Map<string, string>());
  const [jsonInvalid, setJsonInvalid] = useState(false);
  const reportJsonValidity = useCallback((label: string, valid: boolean) => {
    if (valid) invalidJson.current.delete(label);
    else invalidJson.current.add(label);
    setJsonInvalid(invalidJson.current.size > 0);
  }, []);
  const assertJsonValid = () => {
    if (invalidJson.current.size)
      throw new Error(
        "请先修正 JSON 格式错误：" + [...invalidJson.current].join("、"),
      );
    const pending = [...jsonTextCache.current.keys()].filter((key) =>
      key.startsWith((draftRef.current?.id ?? "") + "/"),
    );
    if (pending.length)
      throw new Error(
        "尚有未应用的 JSON 编辑，请返回对应节点修正或完成校验：" +
          pending.join("、"),
      );
  };
  const discardNodeText = (nodeId: string) => {
    const prefix = draftRef.current.id + "/nodes/" + nodeId;
    for (const key of jsonTextCache.current.keys())
      if (key === prefix || key.startsWith(prefix + "/"))
        jsonTextCache.current.delete(key);
    for (const key of invalidJson.current)
      if (key === prefix || key.startsWith(prefix + "/"))
        invalidJson.current.delete(key);
    setJsonInvalid(invalidJson.current.size > 0);
  };
  const act = useCallback(async (fn: () => Promise<J>, message?: string) => {
    const actionPath = pathRef.current;
    setError("");
    setFailure(null);
    setBusy(true);
    try {
      const result = await fn();
      if (message && result !== false && pathRef.current === actionPath)
        setNotice(message);
      return result;
    } catch (e) {
      if (pathRef.current === actionPath) {
        setError(String((e as Error).message));
        setFailure(e);
      }
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const connectWorkspace = useCallback(async () => {
    const currentSession = await openLocalSession();
    initializeEvents(currentSession.eventCursor, async () => {
      const recovered = await recoverLocalSession();
      if (recovered) csrf = recovered.session.csrf;
    });
    setAuth(await api("/auth/state"));
    setSession(currentSession);
    if (inCodexWorkspace) window.parent.postMessage({ type: "flowhub:workspace-ready" }, "*");
  }, []);
  const openLegacyRecovery = () => {
    setModal({
      type: "unlock",
      title: "迁移旧版凭据",
      password: "",
    });
  };
  const loadRuns = useCallback(
    async (cursor?: string, state = runFilterRef.current) => {
      const request = ++runListRequest.current;
      setRunListState("pending");
      const params = new URLSearchParams({
        limit: "50",
        ...(cursor ? { cursor } : {}),
        ...(state ? { state } : {}),
      });
      try {
        const result = await api("/runs?" + params, "GET", undefined, undefined, undefined, true);
        if (request !== runListRequest.current) return;
        if (!Array.isArray(result?.data)) throw new Error("运行记录响应无效。");
        setRuns((old) => cursor
          ? [...old, ...result.data.filter((item: J) => !old.some((known) => known.id === item.id))]
          : result.data);
        setRunsMeta(result.meta);
        setRunListState("ready");
      } catch (e) {
        if (request === runListRequest.current)
          setRunListState({ message: (e as Error).message });
      }
    },
    [],
  );
  const load = async () => {
    await Promise.all([refreshWorkflows(), refreshConnections(), refreshBindings(), refreshTools(),
      refreshRecentRuns(), runListVisible && loadRuns()]);
  };
  const navigate = (next: string, skipDirty = false) => {
    if(deletionPendingRef.current) return false;
    if (!skipDirty && dirty) {
      if (inCodexWorkspace) {
        void workspaceDialog("草稿有未保存修改，是否离开？", "离开").then(answer => {
          if (answer) navigate(next, true);
        });
        return false;
      }
      if (!confirm("草稿有未保存修改，是否离开？")) return false;
    }
    setDirty(false);
    jsonTextCache.current.clear();
    historyIndex.current++;
    history.pushState({ flowhubIndex: historyIndex.current }, "", workspaceHref(next));
    setPath(next);
    setModal(null);
    setPreviewArtifactId(null);
    return true;
  };
  const manageDiscovery = (destination: DiscoveryDestination) => {
    if (destination.type !== "connection") {
      navigate(destination.type === "resources" ? resourceBindingsPath : "/connections");
      return;
    }
    const name = destination.name || "新连接";
    navigate("/connections");
    setModal({ type: "connection", title: "手动连接 · " + name,
      sourceNotice: "来自 能力发现：" + name + "。请按该服务文档选择传输方式并填写独立连接；保存后在工具库点击“检测与同步”。此操作不会修改 Codex 原配置，也不会自动启动服务。",
      payload: { name: name.slice(0, 128), transport: "", protocolEra: "modern" },
    });
  };
  useEffect(() => {
    const replaceRoute = (index: number) => {
      const raw = workspacePath();
      const normalized = normalizeWorkspacePath(raw);
      const url = raw !== normalized && raw !== "/"
        ? workspaceHref(normalized) + location.search + location.hash
        : undefined;
      history.replaceState({ ...history.state, flowhubIndex: index }, "", url);
      return normalized;
    };
    replaceRoute(0);
    const pop = (event: PopStateEvent) => {
      if (restoringHistory.current) {
        restoringHistory.current = false;
        return;
      }
      const nextIndex = event.state?.flowhubIndex;
      const nextPath = normalizeWorkspacePath(workspacePath());
      const askInPage = inCodexWorkspace && dirtyRef.current && !deletionPendingRef.current;
      if (deletionPendingRef.current || askInPage || dirtyRef.current && !confirm("草稿有未保存修改，是否离开？")) {
        if (
          typeof nextIndex === "number" &&
          nextIndex !== historyIndex.current
        ) {
          restoringHistory.current = true;
          history.go(historyIndex.current - nextIndex);
        } else
          history.pushState(
            { flowhubIndex: historyIndex.current },
            "",
            workspaceHref(pathRef.current),
          );
        if (askInPage) void workspaceDialog("草稿有未保存修改，是否离开？", "离开").then(answer => {
          if (answer) navigate(nextPath, true);
        });
        return;
      }
      if (typeof nextIndex === "number") historyIndex.current = nextIndex;
      if (workspacePath() !== "/" && workspacePath() !== nextPath)
        replaceRoute(historyIndex.current);
      setPath(nextPath);
      setDirty(false);
      setModal(null);
      jsonTextCache.current.clear();
    };
    window.addEventListener("popstate", pop);
    void act(connectWorkspace);
    return () => {
      window.removeEventListener("popstate", pop);
    };
  }, []);
  useEffect(() => {
    if (session && runListVisible) void loadRuns();
    return () => { runListRequest.current++; };
  }, [session, runListVisible, loadRuns]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    if (
      ![
        "connection",
        "edit-connection",
        "binding",
        "edit-binding",
        "verify",
      ].includes(modal?.type)
    )
      return;
    let active = true;
    void act(async () => {
      const refs = await api("/secrets");
      if (active) setCredentials(refs);
    });
    return () => {
      active = false;
    };
  }, [modal?.type]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = modalRef.current;
    const focusable = () =>
      Array.from(
        panel?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
        ) ?? [],
      ).filter((element) => element.offsetParent !== null);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current && !deletionPendingRef.current) {
        event.preventDefault();
        setModal(null);
      }
      if (event.key === "Tab") {
        const items = focusable(),
          first = items[0],
          last = items.at(-1);
        if (!items.length) {
          event.preventDefault();
          panel?.focus();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last?.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first?.focus();
        }
      }
    };
    panel?.addEventListener("keydown", keydown);
    return () => {
      panel?.removeEventListener("keydown", keydown);
      previous?.focus();
    };
  }, [modal?.type, session]);
  useEffect(()=>{
    if(deletionPending) modalRef.current?.focus({preventScroll:true});
  },[deletionPending]);
  useEffect(() => {
    undoStack.current = [];
    redoStack.current = [];
    setUndoCount(0);
    setRedoCount(0);
  }, [draft?.id]);
  useEffect(() => {
    if (draft)
      setNodes((old) =>
        old.map((canvasNode) => {
          const definition = draft.draft.nodes.find(
            (n: J) => n.id === canvasNode.id,
          );
          return definition
            ? {
                ...canvasNode,
                data: { ...canvasNode.data, label: nodeLabel(definition) },
              }
            : canvasNode;
        }),
      );
  }, [draft?.draft.nodes]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (dirty || deletionPending) e.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty,deletionPending]);
  const buildCanvas = (record: J, serverBase=false, preserveSelection=false) => {
    assertWorkflowShape(record.draft);
    if(serverBase)serverDraftBase.current=structuredClone(record);
    setDraft(record);
    if(!preserveSelection)setSelected(null);
    setNodes(
      record.draft.nodes.map((n: J, i: number) => ({
        id: n.id,
        type: "default",
        position: record.layout[n.id] ?? {
          x: 230,
          y: i * 140,
        },
        data: {
          label: (
            <div className="node-label">
              <i>{glyph[n.type]}</i>
              <div>
                <small>{labels[n.type]}</small>
                <strong>{n.title}</strong>
                <span>
                  {n.type === "mcp_tool"
                    ? n.config.toolName
                    : n.type === "agent_task"
                      ? n.config.kind
                      : "受控执行节点"}
                </span>
              </div>
            </div>
          ),
        },
        style: {
          width: workflowNodeWidth,
          borderRadius: 12,
          borderColor: "#dce6f3",
          padding: 13,
        },
      })),
    );
    setEdges(
      record.draft.edges.map((e: J, i: number) => ({
        id: "edge-" + i,
        source: e.source,
        target: e.target,
        label:
          e.port === "next"
            ? ""
            : e.port === "true"
              ? "条件满足"
              : "条件不满足",
        type: "smoothstep",
        data: { port: e.port },
        style: { stroke: "#8eafd9", strokeWidth: 2 },
      })),
    );
  };
  const mergeRemoteRecord=(latest:J,changedNodes:string[]=[])=>{
    const local=editorRef.current,base=serverDraftBase.current;
    if(!local||!base||base.id!==latest.id)return;
    const protectedReason=publishReviewRef.current?.type==="publish"?"发布差异仍在审阅，请关闭审阅后重新合并":
      [...jsonTextCache.current.keys()].some(key=>key.startsWith(local.id+"/"))?"存在未应用的 JSON 文本；完成校验后可重新合并":"";
    if(protectedReason){setConflict({base,remote:latest,protectedReason,fields:[]});return;}
    const result=mergeDraft(base,local,latest);
    if(result.invalidEdges.length&&!result.conflicts.length){setConflict({base,remote:latest,protectedReason:"合并后存在节点删除与连线引用冲突，请比较并调整草稿后重试",fields:[]});return;}
    buildCanvas(result.record,false,true);setDirty(result.dirty);setChangedByAI(changedNodes);
    undoStack.current=undoStack.current.map(snapshot=>mergeDraft(base,snapshot,latest).record);
    redoStack.current=redoStack.current.map(snapshot=>mergeDraft(base,snapshot,latest).record);
    if(result.conflicts.length)setConflict({base,remote:latest,fields:result.conflicts});
    else {serverDraftBase.current=structuredClone(latest);setConflict(null);if(result.dirty)setNotice("已合并服务端改图；本地字段仍待保存");}
  };
  syncRemoteRef.current=async(event:J)=>{
    const current=draftRef.current;
    if(!current||current.id!==event.workflowId||(!event.force&&event.revision<=current.revision&&(event.layoutRevision??0)<=(current.layoutRevision??0)))return;
    if(savingRef.current){pendingRemoteEvent.current=event;return;}
    const request=++remoteSyncRequest.current,generation=routeGeneration.current,sourcePath=pathRef.current;
    const editableStamp=()=>JSON.stringify({draft:editorRef.current?.draft,layout:editorRef.current?.layout,raw:[...jsonTextCache.current]});
    const original=editableStamp();
    try{
      const latest=await api("/api/v2/workflows/"+current.id+"/draft");
      if(request!==remoteSyncRequest.current||routeGeneration.current!==generation||pathRef.current!==sourcePath||draftRef.current?.id!==latest.id)return;
      const acknowledged=serverDraftBase.current;
      if(!event.force&&acknowledged?.id===latest.id&&latest.revision<=acknowledged.revision&&(latest.layoutRevision??0)<=(acknowledged.layoutRevision??0))return;
      if(editableStamp()!==original){setConflict({base:serverDraftBase.current,remote:latest,fields:[],protectedReason:"读取服务端期间出现新输入，已保留；请重新合并"});return;}
      mergeRemoteRecord(latest,event.changedNodes??[]);
    }catch(e){if(request===remoteSyncRequest.current&&generation===routeGeneration.current)setError((e as Error).message);}
  };
  const resolveDraftField=(fieldPath:string,choice:"local"|"remote")=>{
    const current=conflictRef.current;if(!current?.remote||current.protectedReason)return;
    const choices={...(current.choices??{}),[fieldPath]:choice};
    const result=mergeDraft(current.base,editorRef.current,current.remote,choices);
    if(result.invalidEdges.length&&!result.conflicts.length){setError("该选择会留下失效连线，请比较节点删除与连线后再处理");return;}
    buildCanvas(result.record,false,true);setDirty(result.dirty);
    if(result.conflicts.length)setConflict({...current,fields:result.conflicts,choices});
    else {serverDraftBase.current=structuredClone(current.remote);setConflict(null);}
  };
  const queuedDraft = useRef<J>(null);
  const scheduleDraftRefresh = useRef<(() => void) | undefined>(undefined);
  useEffect(() => {
    if (!session) return;
    let listPending = false, refreshing = false, active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const flush = async () => {
      timer = undefined;
      refreshing = true;
      const reads: Promise<void>[] = [];
      if (listPending) {
        listPending = false;
        reads.push(refreshWorkflows().catch(error => setError(error.message)));
      }
      const event = queuedDraft.current;
      if (event && pathRef.current !== "/workflows/" + event.workflowId + "/editor") queuedDraft.current = null;
      else if (event && draftRef.current?.id === event.workflowId) {
        queuedDraft.current = null;
        reads.push(syncRemoteRef.current(event));
      }
      try {
        await Promise.all(reads);
      } finally {
        refreshing = false;
        if (listPending || (queuedDraft.current && draftRef.current?.id === queuedDraft.current.workflowId))
          schedule();
      }
    };
    const schedule = () => {
      if (active && !refreshing && timer === undefined) timer = setTimeout(() => void flush(), 50);
    };
    scheduleDraftRefresh.current = schedule;
    const unsubscribe = subscribeEvents(event => {
      if(event.type==="workflow.deleted") {
        deletedWorkflows.current.add(event.workflowId);
        if (queuedDraft.current?.workflowId === event.workflowId) queuedDraft.current = null;
        setWorkflows(previous=>previous.filter(w=>w.id!==event.workflowId));
        if(draftRef.current?.id===event.workflowId && pathRef.current.endsWith("/editor"))
          setNotice("该工作流已删除。此处的未保存内容仍保留，可通过“查看 DSL”复制；不能再保存或发布。");
        return;
      }
      if(event.type!=="draft.changed" || deletedWorkflows.current.has(event.workflowId))return;
      if (needsWorkflowsRef.current) listPending = true;
      if (pathRef.current === "/workflows/" + event.workflowId + "/editor") {
        const previous = queuedDraft.current?.workflowId === event.workflowId ? queuedDraft.current : null;
        queuedDraft.current = {
          ...event,
          layoutRevision: Math.max(event.layoutRevision ?? 0, previous?.layoutRevision ?? 0),
          changedNodes: [...new Set([...(previous?.changedNodes ?? []), ...(event.changedNodes ?? [])])],
        };
      }
      if (listPending || queuedDraft.current) schedule();
    });
    return () => {
      active = false;
      clearTimeout(timer);
      scheduleDraftRefresh.current = undefined;
      unsubscribe();
    };
  }, [session, refreshWorkflows]);
  // A change can arrive while the editor's first draft request is still in flight.
  useEffect(() => {
    if (queuedDraft.current) scheduleDraftRefresh.current?.();
  }, [draft?.id, path]);
  useEffect(()=>{if(!changedByAI.length)return;setNodes(old=>old.map(n=>({...n,style:{...n.style,borderColor:changedByAI.includes(n.id)?"#246bfd":"#dce6f3",boxShadow:changedByAI.includes(n.id)?"0 0 0 3px #246bfd22":undefined}})));const timer=setTimeout(()=>{setChangedByAI([]);setNodes(old=>old.map(n=>({...n,style:{...n.style,boxShadow:undefined}})));},2400);return()=>clearTimeout(timer);},[changedByAI]);
  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    const generation = ++routeGeneration.current;
    let active = true;
    setConflict(null);
    setFailure(null);
    setError("");
    if (/\/workflows\/[^/]+\/editor/.test(path)) {
      const key = path.split("/")[2];
      if (!(dirtyRef.current && draftRef.current?.id === key)) {
        setDraft(null);
        setNodes([]);
        setEdges([]);
        void act(async () => {
          try {
            const record = await api(
              "/workflows/" + key + "/draft",
              "GET",
              undefined,
              undefined,
              controller.signal,
            );
            if (
              active &&
              generation === routeGeneration.current &&
              pathRef.current === path
            )
              buildCanvas(record,true);
          } catch (e) {
            if (active) throw e;
          }
        });
      }
    }
    return () => {
      active = false;
      controller.abort();
    };
  }, [path, session]);
  const refreshRun = async () => {
    if (pathRef.current === "/runs/" + run?.runId) await refreshRunDetail();
    await load();
  };
  const currentWorkflow = () => editorRef.current.draft;
  const previewCanvas = () => {
    const definitions: { id: string; title: string; type: string }[] =
      draft.draft.nodes;
    const definitionsById = new Map(definitions.map((node) => [node.id, node]));
    const cards = nodes.flatMap(({ id, position, measured }) => {
      const definition = definitionsById.get(id);
      if (!definition) return [];
      return [
        {
          id,
          position,
          measured,
          title: definition.title,
          kind: labels[definition.type] ?? definition.type,
          icon: glyph[definition.type] ?? "◇",
        },
      ];
    });
    const diagram = buildWorkflowSvg(draft.draft.name, cards, edges);
    if (diagram) {
      setModal({ type: "workflow-svg", title: "流程图预览", diagram });
    }
  };
  const editorSnapshot = () => structuredClone(editorRef.current);
  const rememberEdit = () => {
    const snapshot = editorSnapshot();
    if (JSON.stringify(undoStack.current.at(-1)) !== JSON.stringify(snapshot))
      undoStack.current = [...undoStack.current.slice(-29), snapshot];
    redoStack.current = [];
    setUndoCount(undoStack.current.length);
    setRedoCount(0);
  };
  const undoEdit = (redo = false) => {
    const from = redo ? redoStack : undoStack,
      to = redo ? undoStack : redoStack;
    const previous = from.current.pop();
    if (!previous) return;
    to.current.push(editorSnapshot());
    buildCanvas({
      ...draftRef.current,
      draft: previous.draft,
      layout: previous.layout,
    });
    setDirty(true);
    setUndoCount(undoStack.current.length);
    setRedoCount(redoStack.current.length);
  };
  const save = async () => {
    assertJsonValid();
    if(conflictRef.current)throw new Error("请先解决草稿字段冲突或重新合并，再保存");
    if (!draft) return;
    if (deletedWorkflows.current.has(draft.id)) throw new Error("该工作流已删除；本地内容仍保留，可通过“查看 DSL”复制。");
    if (pathRef.current !== "/workflows/" + draft.id + "/editor")
      throw new Error("当前页面与草稿不一致，请重新打开工作流");
    const snapshot = editorSnapshot();
    const layout = snapshot.layout;
    const savePath = pathRef.current,
      generation = routeGeneration.current;
    const workflow = snapshot.draft;
    assertWorkflowShape(workflow);
    let result: J;
    try {
      savingRef.current=true;remoteSyncRequest.current++;
      result = await api(
        "/workflows/" + draft.id + "/draft",
        "PUT",
        { workflow, layout, expectedLayoutRevision: snapshot.layoutRevision ?? 1 },
        snapshot.revision,
      );
    } catch (e) {
      if (
        e instanceof UiError &&
        e.status === 409 &&
        pathRef.current === savePath &&
        generation === routeGeneration.current
      )
        setConflict({ workflow, layout, revision: draft.revision });
      throw e;
    } finally { savingRef.current=false; }
    if (
      pathRef.current === savePath &&
      generation === routeGeneration.current
    ) {
      serverDraftBase.current=structuredClone(result);
      const unchanged =
        JSON.stringify(editorRef.current?.draft) === JSON.stringify(workflow) &&
        JSON.stringify(editorRef.current?.layout) === JSON.stringify(layout) &&
        ![...jsonTextCache.current.keys()].some((key) =>
          key.startsWith(snapshot.id + "/"),
        );
      setDraft((latest: J) =>
        latest?.id !== snapshot.id
          ? latest
          : unchanged
            ? result
            : { ...result, draft: latest.draft, layout: latest.layout },
      );
      setDirty(!unchanged);
    }
    if(pendingRemoteEvent.current){const event=pendingRemoteEvent.current;pendingRemoteEvent.current=null;void syncRemoteRef.current(event);}
    await load();
    return result;
  };
  const changeNode = (patch: J, targetId = selected) => {
    rememberEdit();
    setDraft((old: J) => ({
      ...old,
      draft: {
        ...old.draft,
        nodes: old.draft.nodes.map((n: J) =>
          n.id === targetId ? { ...n, ...patch } : n,
        ),
      },
    }));
    setDirty(true);
  };
  const chooseWorkflowById = (id: string) => navigate("/workflows/" + encodeURIComponent(id) + "/editor");
  const chooseWorkflow = (w: J) => chooseWorkflowById(w.id);
  const openStart = (w: J) =>
    act(async () => {
      const sourcePath = pathRef.current;
      const versions = await api("/workflows/" + w.id + "/versions");
      const published = versions.find(
        (v: J) => v.workflowId === w.id && v.version === w.defaultVersion,
      );
      const workflow = published?.snapshot?.workflow;
      if (workflow?.nodes.some((node: J) => node.type === "approval"))
        throw new Error("旧流程已停止新增运行，请先迁移为自动执行副本并发布");
      if (
        !w.defaultVersion ||
        !workflow ||
        workflow.workflowId !== w.id ||
        workflow.version !== published.version
      )
        throw new Error("已发布默认版本不可用，请刷新工作流后重试");
      if (pathRef.current !== sourcePath) return false;
      setModal({
        type: "start",
        title: "启动工作流",
        published,
        clients: (await api("/clients")).filter((c: J) => !c.revoked && c.workflowAllowlist.includes(w.id)),
        clientId: "",
        payload: structuredClone(workflow.inputSchema.examples?.[0] ?? {}),
      });
    });
  const showJson = (title: string, value: J) =>
    setModal({ type: "detail", title, value });
  const startVersion = modal?.type === "start" ? modal.published : null;
  const startWorkflow = startVersion?.snapshot.workflow;
  const node = draft?.draft.nodes.find((n: J) => n.id === selected);
  const hostCapabilityId = node?.config.kind === "host_tool" ? node.config.capabilityRef?.capabilityId : undefined;
  const hostCapabilityRevision = hostCapabilityId ? node.config.capabilityRef.revision : undefined;
  const [hostContract, setHostContract] = useState<J>(null);
  useEffect(() => {
    if (!hostCapabilityId) return;
    const controller = new AbortController();
    const key = hostCapabilityId + "@" + hostCapabilityRevision;
    void api("/api/v2/capabilities/" + encodeURIComponent(hostCapabilityId) +
      "?includeSchemas=true&revision=" + hostCapabilityRevision, "GET", undefined, undefined, controller.signal)
      .then(value => { if (!controller.signal.aborted) setHostContract({ key, value }); })
      .catch(() => { if (!controller.signal.aborted) setHostContract({ key, value: null }); });
    return () => controller.abort();
  }, [hostCapabilityId, hostCapabilityRevision]);
  const currentHostContract = hostContract?.key === hostCapabilityId + "@" + hostCapabilityRevision
    ? hostContract : null;
  const selectedBinding =
    node?.type === "mcp_tool"
      ? bindings.find(
          (binding) =>
            binding.id === draft.draft.bindings[node.config.bindingKey],
        )
      : null;
  const selectedTool = selectedBinding
    ? tools.find(
        (tool) =>
          tool.connectionId === selectedBinding.connectionId &&
          tool.name === node.config.toolName,
      )
    : null;
  const predecessors = node ? mandatoryNodes(currentWorkflow(), node.id) : new Set<string>();
  const sourceNodes = node
    ? draft.draft.nodes
        .filter(
          (source: J) =>
            source.type !== "input" &&
            predecessors.has(source.id),
        )
        .map((source: J) => ({
          id: source.id,
          title: source.title,
          schema:
            source.type === "mcp_tool"
              ? mcpOutputSchema(tools.find(
                  (tool) =>
                    tool.name === source.config.toolName &&
                    tool.connectionId ===
                      bindings.find(
                        (binding) =>
                          binding.id ===
                          draft.draft.bindings[source.config.bindingKey],
                      )?.connectionId,
                )?.outputSchema, source.config.resultAdapterRef)
              : source.type === "condition"
                ? { type: "boolean" }
                : source.config.outputSchema,
        }))
    : [];
  const bindingRoles: string[] = draft
    ? [
        ...new Set<string>([
          ...Object.keys(draft.draft.bindings),
          ...draft.draft.nodes
            .filter((n: J) => n.type === "mcp_tool")
            .map((n: J) => n.config.bindingKey),
        ]),
      ]
    : [];
  const chooseBinding = (role: string, ref: string) => {
    rememberEdit();
    const next = { ...draft.draft.bindings };
    if (ref) next[role] = ref;
    else delete next[role];
    const record = {
      ...draft,
      draft: {
        ...draft.draft,
        bindings: next,
        nodes: draft.draft.nodes.map((n: J) =>
          n.type === "mcp_tool" && n.config.bindingKey === role
            ? {
                ...n,
                config: {
                  ...n.config,
                  toolName: "unconfigured",
                  toolSchemaHash: "placeholder:unconfigured",
                },
              }
            : n,
        ),
        edges: edges.map((e) => ({
          source: e.source,
          target: e.target,
          port: e.data?.port ?? "next",
        })),
      },
      layout: Object.fromEntries(nodes.map((n) => [n.id, n.position])),
    };
    const currentSelection = selected;
    buildCanvas(record);
    setSelected(currentSelection);
    setDirty(true);
  };
  const nodeDefaults: Record<string, J> = {
    input: {},
    end: { resultRef: { ref: { source: "input", pointer: "" } } },
    mcp_tool: {
      bindingKey: "log",
      toolName: "unconfigured",
      toolSchemaHash: "placeholder:unconfigured",
      argumentsMappings: {},
    },
    agent_task: {
      kind: "analysis",
      instructions: "分析当前运行证据，输出结构化结果。",
      inputMappings: {},
      outputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: 4000 } },
        required: ["summary"],
        additionalProperties: false,
      },
    },
    condition: {
      expression: { op: "eq", left: { value: true }, right: { value: true } },
    },
    report_template: {
      templateRef: "incident-markdown/v1",
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
  };
  const addNode = (type: string) => {
    rememberEdit();
    const id = type + "_" + Math.random().toString(36).slice(2, 8),
      n = {
        id,
        title: labels[type],
        type,
        config: structuredClone(nodeDefaults[type]),
      };
    const record = {
      ...draft,
      draft: {
        ...draft.draft,
        nodes: [...draft.draft.nodes, n],
        edges: edges.map((e) => ({
          source: e.source,
          target: e.target,
          port: e.data?.port ?? "next",
        })),
      },
      layout: Object.fromEntries(nodes.map((n) => [n.id, n.position])),
    };
    buildCanvas(record);
    setSelected(id);
    setDirty(true);
  };
  const submitModal = async () => {
    if(deletionPendingRef.current) return;
    const m = modal;
    const successMessage = m.type==="delete-workflow" ? "工作流已删除，历史运行、报告及发布版本已保留" : ["retention", "publish"].includes(m.type)
      ? undefined
      : "操作已完成";
    await act(async () => {
      if (m.type === "delete-workflow") {
        deletionPendingRef.current=true;setDeletionPending(true);
        try {
          await api("/api/v2/workflows/"+encodeURIComponent(m.workflow.id),"DELETE",{
            expectedRevision:m.workflow.revision,expectedLayoutRevision:m.workflow.layoutRevision??1,idempotencyKey:m.idempotencyKey,
          },m.workflow.revision);
        } catch (e) {
          setModal((current:J)=>current===m?{...m,deleteError:(e as Error).message}:current);
          throw e;
        } finally {
          deletionPendingRef.current=false;setDeletionPending(false);
        }
        deletedWorkflows.current.add(m.workflow.id);
        setWorkflows(previous=>previous.filter(w=>w.id!==m.workflow.id));
        setModal((current:J)=>current===m?null:current);
        return true;
      }
      if (m.type !== "unlock") assertJsonValid();
      if (m.type === "condition-port") {
        if (
          pathRef.current !== "/workflows/" + m.workflowId + "/editor" ||
          routeGeneration.current !== m.generation
        )
          return false;
        if (
          !["true", "false"].includes(m.port) ||
          edges.some(
            (edge) =>
              edge.source === m.connection.source && edge.data?.port === m.port,
          )
        )
          throw new Error("该条件出口已连接，请先删除原连线");
        rememberEdit();
        setEdges((old) =>
          addEdge(
            {
              ...m.connection,
              type: "smoothstep",
              label: m.port === "true" ? "条件满足" : "条件不满足",
              data: { port: m.port },
            },
            old,
          ),
        );
        setDirty(true);
        setModal(null);
        return true;
      }
      if (m.type === "publish") {
        const publishPath = "/workflows/" + m.workflow.workflowId + "/editor";
        if (
          pathRef.current !== publishPath ||
          routeGeneration.current !== m.generation
        )
          return false;
        if (
          JSON.stringify(currentWorkflow()) !== JSON.stringify(m.workflow) ||
          draftRef.current?.revision !== m.revision
        )
          throw new UiError("REVISION_CONFLICT","草稿在审阅后发生变化，请重新保存并审阅发布差异",409);
        if(m.workflow.schemaVersion==="flowhub.workflow/v2") await api("/api/v2/workflows/"+m.workflow.workflowId+"/publish","POST",{
          expectedRevision:m.revision,expectedBindingRevisions:m.expectedBindingRevisions,
          expectedCapabilityRevisions:Object.fromEntries(m.workflow.nodes.filter((n:J)=>n.config.capabilityRef).map((n:J)=>[n.config.capabilityRef.capabilityId,n.config.capabilityRef.revision])),
          version:m.workflow.version,idempotencyKey:uid(),
        }); else await api("/workflows/" + m.workflow.workflowId + "/publish", "POST", {
          expectedRevision: m.revision,
          expectedBindingRevisions: m.expectedBindingRevisions,
          changeNote: m.changeNote ?? "",
        });
        if (
          pathRef.current === publishPath &&
          routeGeneration.current === m.generation
        )
          setModal(null);
        await load();
        if (
          pathRef.current === publishPath &&
          routeGeneration.current === m.generation
        ) {
          const latest = await api(
            "/workflows/" + m.workflow.workflowId + "/draft",
          );
          if (
            pathRef.current === publishPath &&
            routeGeneration.current === m.generation
          ) {
            const unchanged =
              JSON.stringify(currentWorkflow()) === JSON.stringify(m.workflow);
            serverDraftBase.current=structuredClone(latest);
            if (unchanged) buildCanvas(latest);
            else
              setDraft((local: J) =>
                local?.id === latest.id
                  ? { ...latest, draft: local.draft, layout: local.layout }
                  : local,
              );
            setDirty(!unchanged);
            setNotice("不可变版本已发布");
          }
        }
        return;
      }
      if (m.type === "start") {
        const workflow = m.published.snapshot.workflow;
        const r = await api("/runs", "POST", {
          workflowId: workflow.workflowId,
          version: workflow.version,
          mode: workflow.mode,
          inputs: m.payload,
          ...(m.clientId ? { clientId: m.clientId } : {}),
          idempotencyKey: uid(),
        });
        setModal(null);
        await load();
        navigate("/runs/" + r.runId);
        return;
      }
      if (m.type === "new" || m.type === "save-as") {
        const errors: J = {};
        if (!m.name.trim()) errors.name = "请输入工作流名称";
        if (!/^[a-z][a-z0-9_-]{0,63}$/.test(m.slug.trim()))
          errors.slug =
            "ID 需以小写字母开头，最多 64 个小写字母、数字、下划线或短横线";
        else if (workflows.some((w) => w.id === m.slug.trim()))
          errors.slug = "工作流 ID 已存在";
        if (!["production", "staging", "test"].includes(m.environment))
          errors.environment = "请选择固定环境";
        if (Object.keys(errors).length) {
          setModal({ ...m, errors });
          return false;
        }
        const base = createWorkflowTemplate(m);
        await api("/workflows", "POST", { workflow: base });
        setModal(null);
        await load();
        navigate("/workflows/" + base.workflowId + "/editor", true);
        return;
      }
      if (m.type === "workflow-config") {
        assertWorkflowShape(m.payload);
        if (m.payload.workflowId !== draft.id)
          throw new Error(
            "工作流 ID 创建后不可修改；请使用新建或导入创建其他工作流",
          );
        const editingPath = pathRef.current;
        const generation = routeGeneration.current;
        const sourceWorkflow = JSON.stringify(currentWorkflow());
        await api("/workflow-imports/preview", "POST", { workflow: m.payload });
        if (
          pathRef.current !== editingPath ||
          routeGeneration.current !== generation
        )
          return false;
        if (JSON.stringify(currentWorkflow()) !== sourceWorkflow)
          throw new Error("校验期间草稿已变化，请重新打开流程配置比较修改");
        rememberEdit();
        buildCanvas({
          ...draftRef.current,
          draft: m.payload,
          layout: editorRef.current.layout,
        });
        setDirty(true);
        setModal(null);
        return;
      }
      if (m.type === "connection") {
        await api("/connections", "POST", m.payload);
      }
      if (m.type === "edit-connection") {
        await api("/connections/" + m.id, "PATCH", m.payload, m.revision);
      }
      if (m.type === "edit-binding") {
        await api("/bindings/" + m.id, "PATCH", m.payload, m.revision);
      }
      if (m.type === "revoke-binding") {
        await api("/bindings/" + m.id, "PATCH", { revoked: true }, m.revision);
      }
      if (m.type === "binding") {
        await api("/bindings", "POST", m.payload);
      }
      if (m.type === "verify") {
        await api("/bindings/" + m.id + "/verify", "POST", m.payload);
      }
      if (m.type === "client") {
        const result = await api("/clients", "POST", m.payload);
        showJson("宿主身份已创建（仅保存令牌文件）", result);
        return;
      }
      if (m.type === "unlock") {
        await api("/credentials/migrate", "POST", { password: m.password });
        setAuth({ ...auth, vaultLocked: false, credentialMigrationRequired: false });
        window.dispatchEvent(new Event("flowhub-credentials-changed"));
      }
      if (m.type === "retention") {
        const result = await api("/retention/commit", "POST", {
          previewHash: m.value.hash,
        });
        setNotice(
          `清理完成：${result.expiredResultRuns} 个运行的原始结果，${result.deletedArtifacts} 份产物，${result.deletedRuns} 个运行的元数据；助手任务 ${result.expiredAssistantTasks??0} 份正文到期、${result.deletedAssistantTasks??0} 条元数据删除，自测 ${result.expiredTestRuns??0} 份结果到期、${result.deletedTestRuns??0} 条元数据删除；历史未归属消息 ${result.expiredLegacyAssistantMessages??0} 条正文到期`,
        );
      }
      if (m.type === "import") {
        await api("/workflow-imports/preview", "POST", { workflow: m.payload });
        await api("/workflow-imports/commit", "POST", { workflow: m.payload });
      }
      setModal(null);
      await load();
      return true;
    }, successMessage);
  };
  const exampleBindings = bindings.filter(b => b.simulationOnly && exampleBindingIds.has(b.id));
  const regularBindings = bindings.filter(b => !b.simulationOnly || !exampleBindingIds.has(b.id));
  const renderBindingCards = (items: J[]) => (
    <div className="binding-grid">
      {items.map((b) => (
        <section className="panel" key={b.id}>
          <div className="row">
            <Badge>{b.environment}</Badge>
            <Badge
              tone={
                b.validationStatus === "REVOKED"
                  ? "red"
                  : b.validationStatus === "UNVERIFIED"
                    ? "amber"
                    : "green"
              }
            >
              {b.validationStatus}
            </Badge>
          </div>
          <h2>{b.name}</h2>
          <p>
            {b.simulationOnly
              ? "合成演示 · 不授权真实生产访问"
              : "独立环境档案"}
          </p>
          <BindingVerificationStatus binding={b} />
          <dl>
            <dt>工具范围</dt>
            <dd>{b.allowedTools.join(", ")}</dd>
            <dt>最大行数</dt>
            <dd>{b.maxRows}</dd>
            <dt>只读模板</dt>
            <dd>{b.allowedQueryTemplates.join(", ") || "不适用"}</dd>
            <dt>绑定修订</dt>
            <dd>{b.revision}</dd>
          </dl>
          <div className="actions">
            <button onClick={() => showJson("资源锁与验证记录", b)}>
              查看策略
            </button>
            <button
              onClick={() =>
                act(async () =>
                  setModal({
                    type: "edit-binding",
                    title: "修改绑定（需重新验证）",
                    id: b.id,
                    revision: b.revision,
                    impact: await api(
                      "/bindings/" + b.id + "/impact",
                    ),
                    payload: Object.fromEntries(
                      [
                        "name",
                        "allowedTools",
                        "lockedArguments",
                        "allowedQueryTemplates",
                        "maxRows",
                        "timeoutSeconds",
                      ].map((k) => [k, b[k]]),
                    ),
                  }),
                )
              }
            >
              编辑
            </button>
            <button
              onClick={() =>
                setModal({
                  type: "verify",
                  id: b.id,
                  title: "独立验证只读绑定",
                  payload: {
                    probe: {
                      toolName: b.allowedTools[0],
                      arguments: bindingProbeDefaults(b),
                    },
                    serverEnforcedReadOnly: false,
                    scope: "",
                    expectedEnvironmentPointer: "/environment",
                    expectedEnvironmentValue: b.environment,
                  },
                })
              }
            >
              验证
            </button>
            <button
              className="danger"
              disabled={b.validationStatus === "REVOKED"}
              onClick={() =>
                act(async () => {
                  setModal({
                    type: "revoke-binding",
                    title: "确认撤销绑定",
                    id: b.id,
                    revision: b.revision,
                    impact: await api(
                      "/bindings/" + b.id + "/impact",
                    ),
                  });
                })
              }
            >
              撤销
            </button>
          </div>
        </section>
      ))}
    </div>
  );
  const assistantWorkflow=page==="editor"&&draft&&path.includes("/"+draft.id+"/")?draft:null;
  const assistantRun = runDetailId && run?.runId === runDetailId ? run : null;
  const assistantContext=assistantWorkflow?{workflowId:assistantWorkflow.id,revision:assistantWorkflow.revision,selectedNodeIds:selected?[selected]:[]}:assistantRun?{workflowId:assistantRun.workflowId,runId:assistantRun.runId,...(previewArtifactId?{artifactRefs:[previewArtifactId]}:{})}:{};
  const assistantContextLabel=assistantWorkflow?"当前流程："+assistantWorkflow.draft.name:assistantRun?"当前运行："+assistantRun.runId.slice(-6):"当前页面："+navigationLabel(page);
  if (!session)
    return (
      <div className="workspace-startup">
        <div className="workspace-startup-card">
          <div className="brand"><b>F</b>FlowHub</div>
          {error ? (
            <>
              <h1>无法打开本机工作区</h1>
              <div role="alert" className="banner error">{error}</div>
              <button disabled={busy} onClick={() => act(connectWorkspace)}>重试连接</button>
            </>
          ) : (
            <p role="status">正在打开本机工作区…</p>
          )}
        </div>
      </div>
    );
  return (
    <div className="app">
      <AppSidebar
        page={page}
        open={navigationOpen}
        close={() => setNavigationOpen(false)}
        navigate={navigate}
      />
      <main>
        <header className="topbar">
          <div className="topbar-navigation">
            <button className="navigation-toggle" aria-label="打开导航" aria-haspopup="dialog" aria-controls={navigationOpen ? "mobile-navigation" : undefined} aria-expanded={navigationOpen} onClick={() => setNavigationOpen(true)}>
              <NavigationIcon name="menu" />
            </button>
            <span className="breadcrumbs" aria-label="当前位置">
              <span>{navigationForPage(page)?.group ?? "工作空间"}</span><b>/</b>
              {page === "editor" ? <>
                <a href={workspaceHref("/workflows")} onClick={event => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); navigate("/workflows");
                }}>{navigationLabel("workflows")}</a>
                <b>/</b><span aria-current="page">流程编排</span>
              </> : page === "resource-bindings" ? <>
                <a href={workspaceHref("/connections")} onClick={event => {
                  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
                  event.preventDefault(); navigate("/connections");
                }}>{navigationLabel("connections")}</a>
                <b>/</b><span aria-current="page">{navigationLabel(page)}</span>
              </> : <span aria-current="page">{navigationLabel(page)}</span>}
            </span>
          </div>
          <div className="topbar-actions">
            <Badge tone="gray">LOCAL FIRST</Badge>
            <button
              onClick={() =>
                act(async () => {
                  await load();
                  if (runDetailId && !(await refreshRunDetail())) return false;
                  setAuth(await api("/auth/state"));
                }, "状态已刷新")
              }
            >
              ↻ 刷新
            </button>
          </div>
        </header>
        <div className="workspace">
          {error && !(modal?.type === "unlock" && failure?.path === "/credentials/migrate") && (
            <div className="banner error" role="alert">
              {error}
              <button onClick={() => setError("")}>×</button>
            </div>
          )}
          {notice && (
            <div className="toast" role="status">
              {notice}
            </div>
          )}
          {page === "discovery" && <DiscoveryPage api={api} onManage={manageDiscovery} onOpenWorkflow={chooseWorkflowById} />}
          {page === "models" && <ModelsPage api={api} />}
          {page === "workflows" && (
            <>
              <PageHead
                eyebrow="YOUR WORKFLOW LIBRARY"
                title={navigationLabel("workflows")}
                text="把排查经验沉淀为可发现、可验证、可追踪的执行方案。"
              >
                <button
                  onClick={() =>
                    setModal({
                      type: "import",
                      title: "导入为禁用草稿",
                      payload: workflows[0]?.draft ?? {},
                    })
                  }
                >
                  导入 JSON
                </button>
                <button
                  className="primary"
                  onClick={() =>
                    setModal({
                      type: "new",
                      title: "新建工作流",
                      name: "新的排查工作流",
                      slug:
                        "workflow-" + Math.random().toString(36).slice(2, 8),
                      environment: "",
                      description: "",
                      template: "blank",
                    })
                  }
                >
                  ＋ 新建工作流
                </button>
              </PageHead>
              <div className="stats">
                {[
                  ["工作流方案", workflows.length, "将流程沉淀为可复用配置"],
                  ["Gateway MCP", "1", "所有方案共享一个入口"],
                  ["下游连接", connections.length, "独立协议与工具目录"],
                  ["运行记录", recentRuns.meta.total, "证据、版本与状态可追踪"],
                ].map(([label, value, caption]) => (
                  <div className="stat" key={String(label)}>
                    <small>{label}</small>
                    <strong>
                      {value}
                      <em>个</em>
                    </strong>
                    <p>{caption}</p>
                  </div>
                ))}
              </div>
              <div className="filterbar">
                <div className="segments">
                  {[
                    ["all", "全部工作流"],
                    ["production", "生产"],
                    ["staging", "试运行"],
                    ["test", "测试"],
                  ].map(([id, text]) => (
                    <button
                      className={filter === id ? "active" : ""}
                      key={id}
                      onClick={() => setFilter(id)}
                    >
                      {text}
                    </button>
                  ))}
                </div>
                <input
                  aria-label="搜索工作流"
                  className="search"
                  placeholder="⌕ 搜索工作流名称或描述"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="workflow-grid">
                {workflows
                  .filter(
                    (w) =>
                      (filter === "all" || w.environment === filter) &&
                      (w.name + w.description + w.id).includes(query),
                  )
                  .map((w) => (
                    <article className="workflow-card" key={w.id} data-workflow-id={w.id}>
                      <div className="card-top">
                        <span
                          className={
                            "large-icon " +
                            (w.environment === "production" ? "" : "green")
                          }
                        >
                          {w.environment === "production" ? "◇" : "⌁"}
                        </span>
                        <Badge
                          tone={
                            !w.enabled
                              ? "gray"
                              : w.defaultVersion
                                ? "green"
                                : "amber"
                          }
                        >
                          {!w.enabled
                            ? "已停用"
                            : w.defaultVersion
                              ? "已发布"
                              : "草稿"}
                        </Badge>
                      </div>
                      <h2>{w.name}</h2>
                      <p>{w.description}</p>
                      <div className="mini-flow">
                        ↳ <span>→</span> ☁ <span>→</span> ✧ <span>→</span> ▧
                      </div>
                      <div className="card-meta">
                        <span>
                          草稿：{w.draft.nodes.length} 个节点 ·{" "}
                          {w.draft.environment}
                        </span>
                        <Badge>
                          {w.defaultVersion
                            ? "默认发布 v" + w.defaultVersion
                            : "未发布"}
                        </Badge>
                      </div>
                      <ExecutionRequirements requirements={w.publishedRequirements} />
                      <div className="card-actions">
                        <button className="danger workflow-delete" disabled={busy || deletionPending} onClick={()=>setModal({
                          type:"delete-workflow",title:"删除工作流",workflow:w,idempotencyKey:uid(),
                        })}>删除</button>
                        <button
                          onClick={() =>
                            act(async () =>
                              setModal({
                                type: "versions",
                                title: "发布版本与默认指针",
                                workflow: w,
                                value: await api(
                                  "/workflows/" + w.id + "/versions",
                                ),
                              }),
                            )
                          }
                        >
                          版本
                        </button>
                        {w.draft.nodes.some((n: J) => n.type === "approval") && <button disabled={busy} onClick={() => act(async () => {
                          const migrated = await api("/workflows/" + w.id + "/migrate-legacy", "POST", {
                            targetId: w.id.slice(0, 40) + "-auto-" + Date.now(), expectedRevision: w.revision,
                          });
                          await load(); chooseWorkflow(migrated.draft);
                        }, "已备份并创建自动执行草稿副本，原版本保留")}>迁移旧流程副本</button>}
                        <button onClick={() => chooseWorkflow(w)}>
                          打开编排
                        </button>
                        <button
                          disabled={busy || !w.defaultVersion || !w.enabled}
                          className="primary"
                          onClick={() => openStart(w)}
                        >
                          启动
                        </button>
                      </div>
                    </article>
                  ))}
              </div>
              {workflows.length === 0 && (
                <Empty text="还没有工作流，请新建或导入草稿" />
              )}
              <div className="info">
                ✧
                内置流程使用合成数据。Codex 接力和 Mock 自测可直接使用，网页助手按需配置模型。
              </div>
            </>
          )}
          {page === "editor" && draft && draft.id === path.split("/")[2] && (
            <>
              <PageHead
                eyebrow="WORKFLOW STUDIO"
                title={draft.draft.name}
                text="流程版本锁定工具、环境和资源。拖动位置不改变执行语义。"
              >
                <button
                  onClick={() => showJson("工作流定义", currentWorkflow())}
                >
                  查看 DSL
                </button>
                <button disabled={nodes.length === 0} onClick={previewCanvas}>
                  预览并导出 SVG
                </button>
                <button
                  onClick={() =>
                    setModal({
                      type: "workflow-config",
                      title: "流程、输入契约与预算",
                      payload: currentWorkflow(),
                    })
                  }
                >
                  流程配置
                </button>
                <button
                  disabled={busy || deletedWorkflows.current.has(draft.id)}
                  onClick={() =>
                    act(async () => {
                      await save();
                      const issues = graphIssues(currentWorkflow());
                      if (issues.length)
                        throw new UiError(
                          "GRAPH_INVALID",
                          "请修正图结构后重新校验",
                          422,
                          { issues },
                        );
                      return await api(
                        "/workflows/" + draft.id + "/validate",
                        "POST",
                        {},
                      );
                    }, "后端校验通过")
                  }
                >
                  校验流程
                </button>
                <button disabled={busy || deletedWorkflows.current.has(draft.id)} onClick={() => act(save, "草稿已保存")}>
                  保存草稿
                </button>
                <button
                  className="primary"
                  disabled={busy || deletedWorkflows.current.has(draft.id)}
                  onClick={() =>
                    act(async () => {
                      const generation = routeGeneration.current;
                      const saved = await save();
                      const publishPath = "/workflows/" + saved.id + "/editor";
                      if (
                        pathRef.current !== publishPath ||
                        routeGeneration.current !== generation
                      )
                        return false;
                      const issues = graphIssues(saved.draft);
                      if (issues.length)
                        throw new UiError(
                          "GRAPH_INVALID",
                          "请修正图结构后发布",
                          422,
                          { issues },
                        );
                      const validation = await api(
                        "/workflows/" + saved.id + "/validate",
                        "POST",
                        {},
                      );
                      const versions = await api(
                        "/workflows/" + saved.id + "/versions",
                      );
                      const previousVersion = versions.find(
                        (version: J) =>
                          version.version === saved.defaultVersion,
                      );
                      const currentBindings = (await api("/bindings")).filter(
                        (binding: J) =>
                          Object.values(saved.draft.bindings).includes(
                            binding.id,
                          ),
                      );
                      if (
                        pathRef.current !== publishPath ||
                        routeGeneration.current !== generation
                      )
                        return false;
                      if (
                        JSON.stringify(currentWorkflow()) !==
                          JSON.stringify(saved.draft) ||
                        [...jsonTextCache.current.keys()].some((key) =>
                          key.startsWith(saved.id + "/"),
                        )
                      )
                        throw new Error(
                          "保存期间还有新的编辑，请重新保存后审阅发布差异",
                        );
                      setModal({
                        type: "publish",
                        title: "确认发布不可变版本",
                        workflow: saved.draft,
                        revision: saved.revision,
                        generation,
                        validation,
                        previous: previousVersion?.snapshot.workflow,
                        previousBindings: summarizeBindings(
                          previousVersion?.snapshot.bindings ?? [],
                        ),
                        bindings: summarizeBindings(currentBindings),
                        expectedBindingRevisions: Object.fromEntries(
                          currentBindings.map((binding: J) => [
                            binding.id,
                            binding.revision,
                          ]),
                        ),
                        changeNote: "",
                      });
                    })
                  }
                >
                  发布版本
                </button>
              </PageHead>
              {deletedWorkflows.current.has(draft.id) && <DeletedWorkflowNotice
                onExport={()=>showJson("已删除流程的本地 DSL",currentWorkflow())}
                onReturn={()=>navigate("/workflows")}
              />}
              <div className="editor-toolbar">
                <Badge tone="green">
                  ◇ {draft.draft.environment} ·{" "}
                  {bindingRoles.some((role) => !draft.draft.bindings[role])
                    ? "绑定未配置"
                    : "固定环境"}
                </Badge>
                <span>{dirty ? "● 有未保存修改" : "✓ 已从服务端加载"} · r{draft.revision}</span>
                {workflowRequirements(draft.draft).requiresCodex && <Badge>需要 Codex 宿主</Badge>}
                <button onClick={openAssistant}>AI 助手</button>
                <button
                  disabled={!undoCount || busy || jsonInvalid}
                  onClick={() => undoEdit()}
                >
                  撤销
                </button>
                <button
                  disabled={!redoCount || busy || jsonInvalid}
                  onClick={() => undoEdit(true)}
                >
                  重做
                </button>
                <button
                  aria-expanded={paletteOpen}
                  aria-controls="editor-palette"
                  onClick={() => showEditorPanel("palette", !paletteOpen)}
                >
                  {paletteOpen ? "收起节点与工具" : "展开节点与工具"}
                </button>
                <button
                  aria-expanded={inspectorOpen}
                  aria-controls="editor-inspector"
                  onClick={() => showEditorPanel("inspector", !inspectorOpen)}
                >
                  {inspectorOpen ? "收起节点属性" : "展开节点属性"}
                </button>
                <label>
                  草稿版本{" "}
                  <input
                    aria-label="草稿版本"
                    value={draft.draft.version}
                    onChange={(e) => {
                      setDraft({
                        ...draft,
                        draft: { ...draft.draft, version: e.target.value },
                      });
                      setDirty(true);
                    }}
                  />
                </label>
              </div>
              {conflict && (
                <section
                  className="panel conflict-panel"
                  role="region"
                  aria-label="草稿冲突处理"
                >
                  <h2>草稿已被其他会话修改</h2>
                  <p>
                    {conflict.fields?.length?"不同字段已合并。本地修改仍保留；同一字段可分别选择保留本地或服务端值。":"本地输入仍保留。处理下方原因后可重新合并，也可比较差异或另存草稿。"}
                  </p>
                  {conflict.protectedReason&&<p role="status">{conflict.protectedReason}</p>}
                  {conflict.fields?.map((field:J)=><article key={field.path} className="panel"><strong>{field.path}</strong><div className="v2-two-columns"><div><p>本地值</p><pre>{field.localMissing?"（删除）":pretty(field.local)}</pre><button onClick={()=>resolveDraftField(field.path,"local")}>保留本地：{field.path}</button></div><div><p>服务端值</p><pre>{field.remoteMissing?"（删除）":pretty(field.remote)}</pre><button onClick={()=>resolveDraftField(field.path,"remote")}>使用服务端：{field.path}</button></div></div></article>)}
                  <button disabled={busy} onClick={()=>void syncRemoteRef.current({workflowId:draft.id,force:true})}>重新尝试合并</button>
                  <div className="actions">
                    <button
                      onClick={() =>
                        act(async () => {
                          const sourcePath = pathRef.current,
                            generation = routeGeneration.current;
                          const latest = await api(
                            "/workflows/" + draft.id + "/draft",
                          );
                          if (
                            sourcePath !== pathRef.current ||
                            generation !== routeGeneration.current
                          )
                            return false;
                          setModal({
                            type: "comparison",
                            title: "比较本地与服务端草稿",
                            before: latest.draft,
                            after: currentWorkflow(),
                          });
                        })
                      }
                    >
                      比较差异
                    </button>
                    <button
                      onClick={() =>
                        setModal({
                          type: "save-as",
                          title: "另存为新工作流",
                          name: draft.draft.name + " 副本",
                          slug: "workflow-" + uid().slice(0, 8),
                          description: draft.draft.description,
                          environment: "",
                          sourceWorkflow: currentWorkflow(),
                        })
                      }
                    >
                      另存草稿
                    </button>
                    <button
                      className="danger"
                      onClick={() =>
                        act(async () => {
                          const sourcePath = pathRef.current,
                            generation = routeGeneration.current;
                          const original = JSON.stringify({
                            editor: editorRef.current,
                            raw: [...jsonTextCache.current],
                          });
                          const latest = await api(
                            "/workflows/" + draft.id + "/draft",
                          );
                          if (
                            sourcePath !== pathRef.current ||
                            generation !== routeGeneration.current
                          )
                            return false;
                          if (
                            JSON.stringify({
                              editor: editorRef.current,
                              raw: [...jsonTextCache.current],
                            }) !== original
                          )
                            throw new Error(
                              "重新加载期间有新的编辑，尚未丢弃；请再次确认重新加载",
                            );
                          routeGeneration.current++;
                          jsonTextCache.current.clear();
                          invalidJson.current.clear();
                          setJsonInvalid(false);
                          buildCanvas(latest,true);
                          setDirty(false);
                          setConflict(null);
                        }, "已加载服务端草稿")
                      }
                    >
                      丢弃本地修改并重新加载
                    </button>
                  </div>
                </section>
              )}
              {(failure || (!dirty && draft.issues?.length > 0)) && (
                <section
                  className="panel validation-panel"
                  aria-label="校验结果"
                >
                  <h2>{failure ? "阻断错误" : "发布前需修正"}</h2>
                  {(
                    failure ? (failure.details?.issues ?? [
                      {
                        code: failure.code ?? "VALIDATION_FAILED",
                        message: failure.message,
                      },
                    ]) : draft.issues
                  ).map((issue: J, index: number) => (
                    <div className="validation-issue" key={index}>
                      <code>{issue.code ?? failure?.code}</code>
                      <span>{issue.message}</span>
                      {(issue.pointer || issue.path) && (
                        <code>{issue.pointer ?? issue.path}</code>
                      )}
                      {issue.nodeId &&
                        draft.draft.nodes.some(
                          (n: J) => n.id === issue.nodeId,
                        ) && (
                          <button
                            onClick={() => {
                              setSelected(issue.nodeId);
                              document
                                .querySelector(
                                  '[data-id="' +
                                    CSS.escape(issue.nodeId) +
                                    '"]',
                                )
                                ?.scrollIntoView({ block: "nearest" });
                            }}
                          >
                            定位节点 {issue.nodeId}
                          </button>
                        )}
                    </div>
                  ))}
                  {failure?.details && !failure.details.issues && (
                    <pre>{pretty(failure.details)}</pre>
                  )}
                </section>
              )}
              <details className="node-list">
                <summary>节点列表（键盘可选择）</summary>
                {draft.draft.nodes.map((definition: J) => (
                  <button
                    key={definition.id}
                    onClick={() => {
                      setSelected(definition.id);
                      showEditorPanel("inspector", true);
                    }}
                  >
                    {definition.title} · {labels[definition.type]} ·{" "}
                    {definition.id}
                  </button>
                ))}
              </details>
              <div
                className="editor"
                onKeyDownCapture={(event) => {
                  if (
                    !(
                      event.target instanceof HTMLInputElement ||
                      event.target instanceof HTMLTextAreaElement ||
                      event.target instanceof HTMLSelectElement
                    ) &&
                    (event.ctrlKey || event.metaKey) &&
                    event.key.toLowerCase() === "z"
                  ) {
                    event.preventDefault();
                    undoEdit(event.shiftKey);
                  }
                }}
              >
                <aside id="editor-palette" className="palette" aria-label="节点与工具" hidden={!paletteOpen}>
                  <div className="editor-panel-heading">
                    <h3>节点与工具</h3>
                    {compactEditor && (
                      <button onClick={() => showEditorPanel("palette", false)}>
                        收起节点与工具
                      </button>
                    )}
                  </div>
                  {draft.draft.schemaVersion==="flowhub.workflow/v2"&&<CapabilityPicker api={api} draft={draft} selected={selected} knownBindings={bindings} dirty={dirty} />}
                  <small>FLOW NODES</small>
                  {Object.entries(labels).map(([type, text]) => (
                    <button key={type} onClick={() => addNode(type)}>
                      <i>{glyph[type]}</i>
                      {text}
                      <span>＋</span>
                    </button>
                  ))}
                  <div className="info">
                    只有串行与互斥分支可发布；禁止并行、循环与回边。
                  </div>
                  <button
                    onClick={() =>
                      showJson("工作流输入 Schema", draft.draft.inputSchema)
                    }
                  >
                    输入契约
                  </button>
                </aside>
                <div className="canvas">
                  <ReactFlow
                    key={draft.id}
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={(changes: NodeChange[]) => {
                      if (changes.some((change) => change.type === "remove"))
                        rememberEdit();
                      setNodes((n) => applyNodeChanges(changes, n));
                      if (
                        changes.some(
                          (c) => c.type === "position" || c.type === "remove",
                        )
                      )
                        setDirty(true);
                      for (const c of changes)
                        if (c.type === "remove") {
                          discardNodeText(c.id);
                          setDraft((w: J) => ({
                            ...w,
                            draft: {
                              ...w.draft,
                              nodes: w.draft.nodes.filter(
                                (n: J) => n.id !== c.id,
                              ),
                            },
                          }));
                          setEdges((e) =>
                            e.filter(
                              (x) => x.source !== c.id && x.target !== c.id,
                            ),
                          );
                        }
                    }}
                    onEdgesChange={(changes) => {
                      if (changes.some((change) => change.type === "remove"))
                        rememberEdit();
                      setEdges((old) => applyEdgeChanges(changes, old));
                      if (changes.some((c) => c.type !== "select"))
                        setDirty(true);
                    }}
                    onNodeClick={(_, n) => {
                      setSelected(n.id);
                      showEditorPanel("inspector", true);
                    }}
                    onConnect={(c: Connection) => {
                      const source = draft.draft.nodes.find(
                        (n: J) => n.id === c.source,
                      );
                      if (source?.type === "condition") {
                        const port = ["true", "false"].find(
                          (candidate) =>
                            !edges.some(
                              (edge) =>
                                edge.source === c.source &&
                                edge.data?.port === candidate,
                            ),
                        );
                        if (!port) {
                          setError("此条件的两个出口均已连接，请先删除原连线");
                          return;
                        }
                        setModal({
                          type: "condition-port",
                          title: "选择互斥条件出口",
                          workflowId: draft.id,
                          generation: routeGeneration.current,
                          connection: c,
                          port,
                        });
                        return;
                      }
                      rememberEdit();
                      const port = "next";
                      setEdges((e) =>
                        addEdge(
                          {
                            ...c,
                            label: port === "next" ? "" : port,
                            data: { port },
                            type: "smoothstep",
                          },
                          e,
                        ),
                      );
                      setDirty(true);
                    }}
                    minZoom={minimumWorkflowZoom}
                    maxZoom={1.5}
                    deleteKeyCode={["Backspace", "Delete"]}
                  >
                    <Background gap={22} size={1} />
                    <WorkflowViewport entryId={draft.draft.nodes.find((node: J) => node.type === "input")?.id} />
                    <Controls showFitView={false} />
                    <MiniMap className="workflow-minimap" pannable zoomable />
                  </ReactFlow>
                </div>
                <aside id="editor-inspector" className="inspector" aria-label="节点属性" hidden={!inspectorOpen}>
                  <div className="actions"><span>节点属性</span><button onClick={openAssistant}>AI 助手</button></div>
                  <>
                  <EditorTextContext.Provider
                    value={{
                      cache: jsonTextCache.current,
                      scope: draft.id + "/nodes/" + (node?.id ?? "none"),
                    }}
                  >
                    <button
                      className="inspector-close"
                      onClick={() => showEditorPanel("inspector", false)}
                    >
                      收起节点属性
                    </button>
                    <details hidden={node?.type !== "mcp_tool"}>
                      <summary>高级绑定设置</summary>
                      {node?.type === "mcp_tool" && (
                        <label className="field">
                          固定环境绑定
                          <select
                            value={node.config.bindingKey}
                            onChange={(e) =>
                              changeNode({
                                config: {
                                  ...node.config,
                                  bindingKey: e.target.value,
                                  toolName: "unconfigured",
                                  toolSchemaHash:
                                    "placeholder:unconfigured",
                                },
                              })
                            }
                          >
                            {bindingRoles.map((k) => (
                              <option key={k} value={k}>
                                {k} · {draft.draft.bindings[k] ?? "未配置"}
                              </option>
                            ))}
                          </select>
                        </label>
                      )}
                      <JsonEditor
                        label="环境绑定引用"
                        textCache={jsonTextCache.current}
                        cacheKey={draft.id + "/bindings"}
                        onValidityChange={reportJsonValidity}
                        onDirty={() => setDirty(true)}
                        validateValue={(bindings) =>
                          assertWorkflowShape({ ...currentWorkflow(), bindings })
                        }
                        value={draft.draft.bindings}
                        onChange={async (v) => {
                          if (!isObject(v))
                            throw new Error("环境绑定引用必须为对象");
                          const generation = routeGeneration.current;
                          const originalBindings = JSON.stringify(
                            currentWorkflow().bindings,
                          );
                          const candidate = { ...currentWorkflow(), bindings: v };
                          await api("/workflow-imports/preview", "POST", {
                            workflow: candidate,
                          });
                          if (
                            pathRef.current !==
                              "/workflows/" + candidate.workflowId + "/editor" ||
                            routeGeneration.current !== generation
                          )
                            return false;
                          if (
                            JSON.stringify(currentWorkflow().bindings) !==
                            originalBindings
                          )
                            throw new Error(
                              "校验期间环境绑定已变化，保留了新选择；请比较后重新应用 JSON",
                            );
                          rememberEdit();
                          setDraft((latest: J) =>
                            latest?.id === candidate.workflowId
                              ? {
                                  ...latest,
                                  draft: { ...latest.draft, bindings: v },
                                }
                              : latest,
                          );
                          setDirty(true);
                          return true;
                        }}
                      />
                    </details>
                    {node ? (
                      <>
                        <div className="inspector-head">
                          <h3>节点配置</h3>
                          <Badge>{labels[node.type]}</Badge>
                        </div>
                        <label className="field">
                          节点名称
                          <input
                            value={node.title}
                            onChange={(e) =>
                              changeNode({ title: e.target.value })
                            }
                          />
                        </label>
                        <label className="field">
                          节点 ID
                          <input disabled value={node.id} />
                        </label>
                        {node.type === "mcp_tool" && (
                          <>
                            <label className="field">
                              资源绑定
                              <select
                                aria-label={"环境绑定 " + node.config.bindingKey}
                                value={draft.draft.bindings[node.config.bindingKey] ?? ""}
                                onChange={(event) =>
                                  chooseBinding(node.config.bindingKey, event.target.value)
                                }
                              >
                                <option value="">请选择同环境资源绑定</option>
                                {bindings.filter(b => b.environment === draft.draft.environment).map(b => (
                                  <option key={b.id} value={b.id} disabled={b.validationStatus === "REVOKED"}>
                                    {b.name}{b.simulationOnly ? "（模拟）" : ""}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <button type="button" onClick={() => navigate(resourceBindingsPath)}>
                              管理直连资源绑定
                            </button>
                            <label className="field">
                              实际 MCP 工具
                              <select
                                value={node.config.toolName}
                                onChange={(e) => {
                                  if (!e.target.value) {
                                    changeNode({
                                      config: {
                                        ...node.config,
                                        toolName: "unconfigured",
                                        toolSchemaHash:
                                          "placeholder:unconfigured",
                                      },
                                    });
                                    return;
                                  }
                                  const t = tools.find(
                                    (t) =>
                                      t.name === e.target.value &&
                                      t.connectionId ===
                                        bindings.find(
                                          (b) =>
                                            b.id ===
                                            draft.draft.bindings[
                                              node.config.bindingKey
                                            ],
                                        )?.connectionId,
                                  );
                                  if (t)
                                    changeNode({
                                      config: {
                                        ...node.config,
                                        toolName: t.name,
                                        toolSchemaHash: t.schemaHash,
                                      },
                                    });
                                }}
                              >
                                <option value="">选择工具</option>
                                {node.config.toolName === "unconfigured" && (
                                  <option value="unconfigured">
                                    未配置，请明确选择
                                  </option>
                                )}
                                {tools
                                  .filter(
                                    (t) =>
                                      t.connectionId ===
                                      bindings.find(
                                        (b) =>
                                          b.id ===
                                          draft.draft.bindings[
                                            node.config.bindingKey
                                          ],
                                      )?.connectionId,
                                  )
                                  .map((t) => (
                                    <option key={t.name} value={t.name}>
                                      {t.name}
                                    </option>
                                  ))}
                              </select>
                            </label>
                            <div className="lock-card">
                              运行时使用绑定中固定的资源参数。
                              {selectedBinding && (
                                <pre>
                                  {pretty({
                                    validationStatus:
                                      selectedBinding.validationStatus,
                                    lockedArguments:
                                      selectedBinding.lockedArguments,
                                    maxRows: selectedBinding.maxRows,
                                    timeoutSeconds:
                                      selectedBinding.timeoutSeconds,
                                  })}
                                </pre>
                              )}
                            </div>
                          </>
                        )}
                        {hostCapabilityId && (
                          <p>
                            Codex 具名工具 · r{hostCapabilityRevision} ·{" "}
                            {currentHostContract ? currentHostContract.value?.name ?? "契约暂不可读" : "正在读取冻结契约…"}
                          </p>
                        )}
                        {node.config.kind === "host_plugin" && (
                          <div className="lock-card">
                            <strong>Codex 插件任务 · r{node.config.pluginRef.revision}</strong>
                            {node.config.scope && <dl>
                              <dt>固定项目</dt><dd><code>{node.config.scope.projectId}</code></dd>
                              <dt>固定测试环境</dt><dd><code>{node.config.scope.environmentId}</code></dd>
                            </dl>}
                            <p>{node.config.instructions}</p>
                          </div>
                        )}
                        {node.config.kind === "host_tool" && node.config.requireHostReceipt && (
                          <ReceiptScopeFields
                            key={"receipt-scopes:" + node.id}
                            value={node.config.receiptScopeMappings ?? {}}
                            inputSchema={currentHostContract?.value?.inputSchema}
                            outputSchema={node.config.outputSchema}
                            onChange={(receiptScopeMappings) => changeNode({
                              config: { ...node.config, receiptScopeMappings },
                            })}
                          />
                        )}
                        {(node.type === "mcp_tool" ||
                          node.type === "agent_task") && (
                          <MappingFields
                            key={node.id}
                            value={
                              node.config.argumentsMappings ??
                              node.config.inputMappings ??
                              {}
                            }
                            nodeId={node.id}
                            inputSchema={draft.draft.inputSchema}
                            sourceNodes={sourceNodes}
                            targetSchema={selectedTool?.inputSchema ?? currentHostContract?.value?.inputSchema}
                            lockedArguments={
                              selectedBinding?.lockedArguments ?? {}
                            }
                            onValidityChange={reportJsonValidity}
                            onDirty={() => setDirty(true)}
                            onChange={(value) =>
                              changeNode({
                                config: {
                                  ...node.config,
                                  [node.type === "mcp_tool"
                                    ? "argumentsMappings"
                                    : "inputMappings"]: value,
                                },
                              })
                            }
                          />
                        )}
                        {node.type === "condition" && (
                          <ConditionFields
                            key={node.id}
                            value={node.config.expression}
                            inputSchema={draft.draft.inputSchema}
                            sourceNodes={sourceNodes}
                            onValidityChange={reportJsonValidity}
                            onDirty={() => setDirty(true)}
                            onChange={(expression: J) =>
                              changeNode({
                                config: { ...node.config, expression },
                              })
                            }
                          />
                        )}
                        {(node.type === "mcp_tool" ||
                          (node.type === "agent_task" && node.config.kind !== "host_skill")) && (
                          <details className="business-rule-guide">
                            <summary>业务核验规则</summary>
                            <p>在节点配置中声明用来判断业务核验结果的输出字段和对应值。</p>
                            {draft.draft.schemaVersion !== "flowhub.workflow/v2" ? (
                              <button onClick={() => {
                                rememberEdit();
                                setDraft((old: J) => ({
                                  ...old, draft: { ...old.draft, schemaVersion: "flowhub.workflow/v2" },
                                }));
                                setDirty(true);
                              }}>升级当前草稿以配置核验规则</button>
                            ) : (
                              <pre>{pretty({ businessVerification: {
                                pointer: "/state", verified: ["ok"], unavailable: ["unavailable"],
                                failed: ["failed"], rowCountPointer: "/rowCount",
                              } })}</pre>
                            )}
                            {node.config.businessVerification && <small>已声明核验字段 {node.config.businessVerification.pointer || "/"}</small>}
                          </details>
                        )}
                        <JsonEditor
                          key={draft.id + "/nodes/" + node.id}
                          label="节点配置（映射 / Schema）"
                          textCache={jsonTextCache.current}
                          cacheKey={draft.id + "/nodes/" + node.id}
                          onValidityChange={reportJsonValidity}
                          onDirty={() => setDirty(true)}
                          validateValue={(config) =>
                            assertWorkflowShape({
                              ...currentWorkflow(),
                              nodes: draft.draft.nodes.map((n: J) =>
                                n.id === node.id ? { ...n, config } : n,
                              ),
                            })
                          }
                          value={node.config}
                          onChange={async (config) => {
                            if (!isObject(config))
                              throw new Error("节点配置必须为对象");
                            const generation = routeGeneration.current;
                            const originalConfig = JSON.stringify(
                              currentWorkflow().nodes.find(
                                (definition: J) => definition.id === node.id,
                              )?.config,
                            );
                            const candidate = {
                              ...currentWorkflow(),
                              nodes: currentWorkflow().nodes.map(
                                (definition: J) =>
                                  definition.id === node.id
                                    ? { ...definition, config }
                                    : definition,
                              ),
                            };
                            await api("/workflow-imports/preview", "POST", {
                              workflow: candidate,
                            });
                            if (
                              pathRef.current ===
                                "/workflows/" +
                                  candidate.workflowId +
                                  "/editor" &&
                              routeGeneration.current === generation
                            ) {
                              if (
                                JSON.stringify(
                                  currentWorkflow().nodes.find(
                                    (definition: J) =>
                                      definition.id === node.id,
                                  )?.config,
                                ) !== originalConfig
                              )
                                throw new Error(
                                  "校验期间节点配置已变化，保留了新编辑；请比较后重新应用 JSON",
                                );
                              changeNode({ config }, node.id);
                              return true;
                            }
                            return false;
                          }}
                        />
                        {node.type === "mcp_tool" && (
                          <button
                            onClick={() =>
                              showJson(
                                "实际工具 Schema",
                                selectedTool ?? {
                                  message:
                                    "当前绑定和工具尚未配置，或工具目录已变化",
                                },
                              )
                            }
                          >
                            查看真实输入 / 输出 Schema
                          </button>
                        )}
                        <button
                          onClick={() => {
                            rememberEdit();
                            const id = node.type + "_" + uid().slice(0, 8);
                            const copied = {
                              ...structuredClone(node),
                              id,
                              title: node.title + " 副本",
                            };
                            buildCanvas({
                              ...editorSnapshot(),
                              draft: {
                                ...currentWorkflow(),
                                nodes: [...draft.draft.nodes, copied],
                              },
                            });
                            setSelected(id);
                            setDirty(true);
                          }}
                        >
                          复制节点
                        </button>
                        <button
                          className="danger"
                          onClick={() => {
                            rememberEdit();
                            if (selected) discardNodeText(selected);
                            setNodes((x) => x.filter((n) => n.id !== selected));
                            setEdges((x) =>
                              x.filter(
                                (e) =>
                                  e.source !== selected &&
                                  e.target !== selected,
                              ),
                            );
                            setDraft({
                              ...draft,
                              draft: {
                                ...draft.draft,
                                nodes: draft.draft.nodes.filter(
                                  (n: J) => n.id !== selected,
                                ),
                              },
                            });
                            setSelected(null);
                            setDirty(true);
                          }}
                        >
                          删除节点
                        </button>
                      </>
                    ) : (
                      <Empty text="选择节点，查看工具、参数映射和输出契约" />
                    )}
                  </EditorTextContext.Provider>
                </>
                </aside>
              </div>
              <TestingPanel api={api} workflowId={draft.id} revision={draft.revision} />
            </>
          )}
          {page === "connections" && (
            <>
              <PageHead
                eyebrow="CONNECTED CAPABILITIES"
                title={navigationLabel("connections")}
                text="登记独立连接，读取实际工具目录及 Schema 指纹。认证失败不会触发降级。"
              >
                <button type="button" onClick={() => navigate(resourceBindingsPath)}>
                  {navigationLabel("resource-bindings")}
                </button>
                <button
                  className="primary"
                  onClick={() =>
                    setModal({
                      type: "connection",
                      title: "登记 MCP 连接",
                      payload: {
                        name: "新连接",
                        transport: "streamable_http",
                        protocolEra: "modern",
                        endpoint: "",
                        allowedHosts: [],
                      },
                    })
                  }
                >
                  ＋ 添加连接
                </button>
              </PageHead>
              <div className="connection-grid">
                {connections.map((c) => (
                  <section className="panel" key={c.id}>
                    <div className="row">
                      <span className="large-icon">⌘</span>
                      <Badge
                        tone={
                          c.disabled ? "gray" : c.verifiedAt ? "green" : "amber"
                        }
                      >
                        {c.disabled
                          ? "已禁用"
                          : c.verifiedAt
                            ? "已验证协议"
                            : "待验证"}
                      </Badge>
                    </div>
                    <h2>{c.name}</h2>
                    <p>
                      {c.synthetic
                        ? "内置合成 MCP · 不访问企业系统"
                        : c.transport + " · " + c.protocolEra}
                    </p>
                    <div className="metrics">
                      <span>{c.tools?.length ?? 0} 工具</span>
                      <code>revision {c.revision}</code>
                    </div>
                    <div className="actions">
                      <button
                        onClick={() =>
                          act(async () => {
                            await api(
                              "/connections/" + c.id + "/sync-tools",
                              "POST",
                              {},
                            );
                            await load();
                          }, "已完成真实协议发现")
                        }
                      >
                        检测与同步
                      </button>
                      <button
                        onClick={() =>
                          showJson("连接 Schema 历史", c.history ?? [])
                        }
                      >
                        历史摘要
                      </button>
                      {!c.synthetic && (
                        <button
                          onClick={() =>
                            setModal({
                              type: "edit-connection",
                              title: "修改连接（使验证失效）",
                              id: c.id,
                              revision: c.revision,
                              payload: Object.fromEntries(
                                [
                                  "name",
                                  "endpoint",
                                  "allowedHosts",
                                  "secretRef",
                                  "command",
                                  "args",
                                  "commandApproved",
                                  "envRefs",
                                  "protocolEra",
                                ]
                                  .filter((k) => c[k] !== undefined)
                                  .map((k) => [k, c[k]]),
                              ),
                            })
                          }
                        >
                          编辑
                        </button>
                      )}
                      {!c.synthetic && (
                        <button
                          onClick={() =>
                            act(async () => {
                              await api(
                                "/connections/" + c.id,
                                "PATCH",
                                { disabled: !c.disabled },
                                c.revision,
                              );
                              await load();
                            })
                          }
                        >
                          {c.disabled ? "启用" : "禁用"}
                        </button>
                      )}
                    </div>
                  </section>
                ))}
              </div>
              <section className="panel">
                <h2>
                  已发现工具 <small>{tools.length}</small>
                </h2>
                <div className="table-scroll" role="region" aria-label="已发现工具列表" tabIndex={0}>
                  <table>
                    <thead>
                      <tr>
                        <th>工具名称</th>
                        <th>连接</th>
                        <th>Schema 指纹</th>
                        <th>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {tools.map((t, i) => (
                        <tr key={i}>
                          <td>
                            <strong>{t.name}</strong>
                            <small>{t.description}</small>
                          </td>
                          <td>{t.connectionName}</td>
                          <td>
                            <code>{t.schemaHash.slice(0, 22)}…</code>
                          </td>
                          <td>
                            <button onClick={() => showJson(t.name, t)}>
                              查看契约
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
          {page === "resource-bindings" && (
            <>
              <PageHead
                eyebrow="FLOWHUB DIRECT"
                title={navigationLabel("resource-bindings")}
                text="为 FlowHub 独立执行的节点固定连接、环境和资源参数。"
              >
                <button
                  className="primary"
                  onClick={() =>
                    setModal({
                      type: "binding",
                      title: "创建绑定档案",
                      payload: {
                        name: "新的只读绑定",
                        connectionId: "",
                        environment: "",
                        allowedTools: [],
                        lockedArguments: {},
                        allowedQueryTemplates: [],
                        maxRows: 100,
                        timeoutSeconds: 30,
                      },
                    })
                  }
                >
                  ＋ 添加资源绑定
                </button>
              </PageHead>
              {regularBindings.length > 0
                ? renderBindingCards(regularBindings)
                : <Empty text="还没有直连资源绑定。添加 MCP 连接并同步工具后，可为直连节点配置资源。" />}
              {exampleBindings.length > 0 && (
                <details className="panel binding-examples">
                  <summary>内置示例（{exampleBindings.length}）</summary>
                  {renderBindingCards(exampleBindings)}
                </details>
              )}
            </>
          )}
          {page === "runs" && !/^\/runs\/[^/]+$/.test(path) && (
            <>
              <PageHead
                eyebrow="EXECUTION HISTORY"
                title="运行记录"
                text="查看不可变运行快照、Agent 待办及证据归档。"
              />
              <section className="panel">
                <label className="field">
                  运行状态筛选
                  <select
                    aria-label="运行状态筛选"
                    value={runFilter}
                    onChange={(event) => {
                      const value = event.target.value;
                      setRunFilter(value);
                      runFilterRef.current = value;
                      void act(() => loadRuns(undefined, value));
                    }}
                  >
                    <option value="">全部状态</option>
                    {Object.entries(statusLabels).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </label>
                {runListState === "pending" && <p role="status">正在读取运行记录…</p>}
                {typeof runListState === "object" && (
                  <>
                    <p role="alert" className="error">无法读取运行记录。{runListState.message}</p>
                    <button onClick={() => void loadRuns()}>重试读取运行记录</button>
                  </>
                )}
                <div className="table-scroll" role="region" aria-label="运行记录列表" tabIndex={0}>
                  <table>
                    <thead>
                      <tr>
                        <th>运行 / 工作流</th>
                        <th>环境</th>
                        <th>状态</th>
                        <th>时间</th>
                        <th />
                      </tr>
                    </thead>
                    <tbody>
                      {runs.map((r) => (
                        <tr key={r.id}>
                          <td>
                            <strong>{r.workflowId}</strong>
                            <small>
                              {r.id.slice(0, 24)}… · v{r.version}
                            </small>
                          </td>
                          <td>
                            <Badge>{r.environment}</Badge>
                          </td>
                          <td>
                            <Badge
                              tone={
                                r.state === "SUCCEEDED"
                                  ? "green"
                                  : typeof r.state === "string" && r.state.startsWith("WAITING")
                                    ? "amber"
                                    : "gray"
                              }
                            >
                              {statusLabels[r.state] ?? r.state ?? "状态未记录"}
                            </Badge>
                            <RunBusinessOutcome summary={r.businessVerification} archived={r.reportArchived} />
                            {r.syntheticExecution && <small>合成运行</small>}
                          </td>
                          <td>
                            {new Date(r.createdAt).toLocaleString("zh-CN", {
                              timeZone: "Asia/Shanghai",
                            })}
                          </td>
                          <td>
                            <button onClick={() => navigate("/runs/" + r.id)}>
                              查看详情 →
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {runListState === "ready" && !runs.length && (
                  <Empty text="暂无运行，从工作流启动一次合成排查" />
                )}
                {runListState === "ready" && runsMeta?.hasMore && (
                  <button
                    disabled={busy}
                    onClick={() => act(() => loadRuns(runsMeta.nextCursor))}
                  >
                    加载更早运行
                  </button>
                )}
              </section>
            </>
          )}
          {runDetailId && !assistantRun && (
            <>
              {!assistantRun && (
                <PageHead eyebrow="RUN DETAIL" title="运行详情" text={runDetailId}>
                  <button onClick={() => navigate("/runs")}>返回运行记录</button>
                </PageHead>
              )}
              <section className="panel">
                {currentRunIssue ? (
                  <>
                    <p role="alert" className="error">无法读取运行详情。{currentRunIssue}</p>
                    <button onClick={() => void refreshRunDetail()}>重试读取运行详情</button>
                  </>
                ) : <p role="status">正在读取运行详情…</p>}
              </section>
            </>
          )}
          {run && assistantRun && (
              <>
                <PageHead
                  eyebrow="RUN DETAIL"
                  title={run.workflowId ?? "运行详情"}
                  text={run.version ? run.runId + " · v" + run.version : run.runId}
                >
                  <button onClick={() => navigate("/runs")}>返回运行记录</button>
                  <Badge>{run.environment} · 不可变快照</Badge>
                  <button
                    onClick={() =>
                      act(async () => {
                        await api("/runs/" + run.runId + "/cancel", "POST", {
                          expectedRevision: run.revision,
                          reason: "管理员主动取消",
                          idempotencyKey: uid(),
                        });
                        await refreshRun();
                      })
                    }
                  >
                    取消运行
                  </button>
                </PageHead>
                {currentRunIssue && (
                  <div className="banner error" role="alert">
                    更新运行详情失败。{currentRunIssue}
                    <button onClick={() => void refreshRunDetail()}>重试读取运行详情</button>
                  </div>
                )}
                <div className="run-summary">
                  <Badge tone={run.state === "SUCCEEDED" ? "green" : "amber"}>
                    {statusLabels[run.state] ?? run.state ?? "状态未记录"}
                  </Badge>
                  <span>revision {run.revision}</span>
                  {run.syntheticExecution && <Badge>合成运行</Badge>}
                  {typeof run.snapshotHash === "string" && run.snapshotHash
                    ? <code>{run.snapshotHash.slice(0, 28)}…</code>
                    : <span>快照哈希未记录</span>}
                  {run.waitingReason && (
                    <span className="error">{run.waitingReason}</span>
                  )}
                </div>
                <section className="panel">
                  <RunBusinessOutcome summary={run.businessVerification} archived={run.reportArchived} detail />
                  <ExecutionEvidence evidence={run.validationEvidence} hostResult={run.hostResultReceived} synthetic={run.syntheticExecution} />
                  <button onClick={openAssistant}>使用助手解释当前运行</button>
                  <p>聊天会附带当前运行，工具结果与来源可按轮次展开查看。</p>
                </section>
                <div className="run-grid">
                  <section className="panel">
                    <h2>执行步骤</h2>
                    <p>当前节点：{run.currentNode}</p>
                    {run.nodeDetails?.some((node: J) => node.nodeId === run.currentNode && node.executor === "codex_host") &&
                      hostReceiptHint(run.waitingReason) && <p className="error">{hostReceiptHint(run.waitingReason)}</p>}
                    {Array.isArray(run.nodeDetails) && run.nodeDetails.map((node: J) => <details key={node.nodeId}>
                      <summary>{node.title} · {run.steps?.[node.nodeId] ?? "未记录"}{node.toolName ? " · " + node.toolName : ""}{node.durationMs > 0 ? " · " + node.durationMs + " ms" : ""}</summary>
                      {node.executor && <p>执行者 {({
                        codex_host: "Codex 宿主", assistant_local: "内置助手",
                        hub_direct: "FlowHub", hub_template: "FlowHub 模板",
                      } as Record<string, string>)[node.executor] ?? node.executor}
                        {node.source?.name && " · " + node.source.name}
                        {(node.source?.synthetic || node.source?.verification === "synthetic_fixture") && " · 合成"}
                        {node.source?.origin === "flowhub" ? " · FlowHub 状态记录"
                          : (node.source?.origin === "codex_host" || node.source?.checkpointId ||
                            node.source?.verification === "host_reported" || node.source?.verification === "synthetic_fixture")
                            && " · Codex 回报"}
                        {node.executor === "hub_direct" && run.steps?.[node.nodeId] === "SUCCEEDED" && " · FlowHub 已记录调用"}
                      </p>}
                      {node.source?.argumentsHash && <p>回执参数摘要 <code>{node.source.argumentsHash}</code></p>}
                      {node.source?.pluginName && (
                        <p>{node.source.pluginName} · {(node.source.tools ?? []).map((call: J) => call.tool).join(" → ")}</p>
                      )}
                      {node.source?.toolCallId && <p>宿主调用 ID <code>{node.source.toolCallId}</code></p>}
                      {node.errorCode && node.source?.artifactId && run.artifacts?.some((artifact: J) => artifact.id === node.source.artifactId) && (
                        <p>失败诊断见运行产物 <code>{node.source.artifactId}</code></p>
                      )}
                      {node.arguments !== undefined && <><strong>调用参数</strong><pre>{pretty(node.arguments)}</pre></>}
                      {run.outputs?.[node.nodeId] !== undefined && <><strong>执行结果</strong><pre>{pretty(run.outputs[node.nodeId])}</pre></>}
                      {node.errorCode && <p className="error">{(node.executor === "codex_host" && hostReceiptHint(node.errorCode)) || node.errorCode}</p>}
                    </details>)}
                    <div className="timeline">
                      {Object.entries(run.steps ?? {}).map(([id, state]) => (
                        <div
                          key={id}
                          className={state === "SUCCEEDED" ? "done" : ""}
                        >
                          <i>
                            {state === "SUCCEEDED"
                              ? "✓"
                              : state === "SKIPPED"
                                ? "−"
                                : "○"}
                          </i>
                          <strong>{id}</strong>
                          <Badge
                            tone={state === "SUCCEEDED" ? "green" : "gray"}
                          >
                            {String(state)}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </section>
                  <div>
                    {(run.checkpoint?.legacyDataUnavailable || run.outputAvailability === "VAULT_LOCKED") && (
                      <p className="banner">此历史运行包含旧版加密数据，可在「系统设置」的「恢复旧版数据」中恢复。</p>
                    )}
                    {run.checkpoint && (
                      <section className="panel">
                        <Badge>WAITING_AGENT · {run.checkpoint.kind}</Badge>
                        <h2>{run.checkpoint.nodeId} · 宿主待办</h2>
                        <p>{run.checkpoint.instruction}</p>
                        {run.checkpoint.claimedAt && <p>当前检查点已认领，等待接力会话提交回执。</p>}
                        <RunContinuation key={run.runId} run={run} />
                        <RunAnalysisControl api={api} run={run}/>
                        <small>
                          等待已连接的 Codex 通过 workflow_status
                          获取交接信息，并通过 workflow_advance 提交结构化结果。
                        </small>
                        <div className="actions">
                          <button
                            onClick={() =>
                              showJson(
                                "检查点输出契约",
                                run.checkpoint.requiredOutputSchema,
                              )
                            }
                          >
                            输出 Schema
                          </button>
                          <button
                            onClick={() =>
                              act(async () => {
                                await navigator.clipboard.writeText(run.runId);
                              }, "runId 已复制")
                            }
                          >
                            复制 runId
                          </button>
                        </div>
                      </section>
                    )}
                    {run.state === "BLOCKED" && (
                      <button
                        onClick={() =>
                          act(async () => {
                            await api(
                              "/runs/" + run.runId + "/resume",
                              "POST",
                              {},
                            );
                            await refreshRun();
                          })
                        }
                      >
                        条件恢复后继续
                      </button>
                    )}
                    {[
                      "OUTCOME_UNKNOWN",
                      "FAILED",
                      "REJECTED",
                      "CANCELLED",
                    ].includes(run.state) && (
                      <button
                        onClick={() =>
                          act(async () => {
                            const reason = inCodexWorkspace
                              ? await workspaceDialog("人工复核并创建新运行", "创建新运行", "复核原因")
                              : prompt(
                              "复核原因（保留原运行终态，创建新运行）",
                            );
                            if (reason) {
                              const r = await api(
                                "/runs/" + run.runId + "/review",
                                "POST",
                                { reason, idempotencyKey: uid() },
                              );
                              navigate("/runs/" + r.runId);
                            }
                          })
                        }
                      >
                        人工复核并创建新运行
                      </button>
                    )}
                    <RunArtifacts
                      key={run.runId}
                      runId={run.runId}
                      artifacts={Array.isArray(run.artifacts) ? run.artifacts : []}
                      onPreview={setPreviewArtifactId}
                      getChunk={(path, signal) => api(path, "GET", undefined, undefined, signal)}
                      getDownload={(path, signal) => apiResponse(path, "GET", undefined, undefined, signal)}
                    />
                    <section className="panel">
                      <h2>事件时间线</h2>
                      {run.events.map((e: J) => (
                        <div className="event" key={e.seq}>
                          <code>#{e.seq}</code>
                          <strong>{e.type}</strong>
                          <small>
                            {e.nodeId} ·{" "}
                            {new Date(e.createdAt).toLocaleTimeString("zh-CN", {
                              timeZone: "Asia/Shanghai",
                            })}
                          </small>
                        </div>
                      ))}
                    </section>
                  </div>
                </div>
              </>
            )}
          {page === "settings" && (
            <>
              <PageHead
                eyebrow="GATEWAY & SECURITY"
                title={navigationLabel("settings")}
                text="管理 MCP 宿主身份和数据备份。"
              />
              <div className="settings-grid">
                <SettingsIntegration
                  api={api}
                  workflows={workflows}
                  disabled={busy}
                />
                <section className="panel">
                  <h2>数据保留与清理</h2>
                  <p>
                    终态原始结果默认保留 7 天；业务输入与运行元数据保留 30 天。
                    活跃运行不清理，已有备份独立保留。
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      act(async () =>
                        setModal({
                          type: "retention",
                          title: "数据保留与清理预览",
                          value: retentionPreview(await api("/retention/preview", "POST", {})),
                        }),
                      )
                    }
                  >
                    预览清理范围
                  </button>
                  {auth?.credentialMigrationRequired && (
                    <details>
                      <summary>恢复旧版数据</summary>
                      <p>使用原口令恢复该版本保存的连接认证、模型 Key 或加密运行结果。</p>
                      <button disabled={busy} onClick={openLegacyRecovery}>迁移旧版凭据</button>
                    </details>
                  )}
                </section>
                <section className="panel">
                  <h2>诊断导出（仅元数据）</h2>
                  <p>
                    程序与数据分离。备份包含敏感状态，只保存在本机；支持包仅导出白名单元数据。
                  </p>
                  <div className="actions">
                    <button
                      onClick={() =>
                        act(async () =>
                          setModal({
                            type: "support",
                            title: "预览支持包",
                            ...(await api(
                              "/support-bundles/preview",
                              "POST",
                              {},
                            )),
                          }),
                        )
                      }
                    >
                      预览支持包
                    </button>
                  </div>
                </section>
                <section className="panel">
                  <h2>版本与验收</h2>
                  <p>{auth?.version} · 本机单用户</p>
                  <p>
                    云端测试仅使用合成数据。Windows 原生构建、真实 Codex
                    和企业只读联调需分别验收，不由本机 UI 或 Mock 自动认证。
                  </p>
                  <button
                    onClick={() =>
                      act(async () =>
                        showJson("服务配置", await api("/settings")),
                      )
                    }
                  >
                    查看服务配置
                  </button>
                </section>
              </div>
            </>
          )}
        </div>
        <footer>
          FLOWHUB <span>一个入口 · 受控执行 · 证据可追踪</span>
          <small>本机工作空间</small>
        </footer>
      </main>
      <FloatingAssistant
        api={api}
        context={assistantContext}
        contextLabel={assistantContextLabel}
        dirty={dirty}
        openRequest={assistantOpenRequest}
        workflows={workflows}
        runs={useVisibleRuns ? runs : recentRuns.data}
        onReferencesChange={setAssistantReferencesOpen}
        onNavigate={navigate}
        onOpenWorkflow={id=>navigate("/workflows/"+id+"/editor")}
      />
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target !== e.currentTarget) return;
            if (deletionPendingRef.current) {
              e.preventDefault();
              modalRef.current?.focus({preventScroll:true});
              return;
            }
            closeModal();
          }}
        >
          <section
            ref={modalRef}
            tabIndex={-1}
            className={
              "modal " + (["detail", "workflow-svg"].includes(modal.type)
                ? "wide"
                : modal.type === "delete-workflow"
                  ? "workflow-delete-dialog"
                  : "")
            }
            role="dialog"
            aria-modal="true"
            aria-label={modal.title}
          >
            <div className="modal-head">
              <h2>{modal.title}</h2>
              <button aria-label="关闭" disabled={deletionPending} onClick={closeModal}>
                ×
              </button>
            </div>
            {modal.sourceNotice && <p className="banner">{modal.sourceNotice}</p>}
            {modal.type === "delete-workflow" ? (
              <>
                <p>确认删除工作流 <strong>{modal.workflow.name}</strong>？</p>
                <p className="muted">{modal.workflow.id}</p>
                <ul>
                  <li>从工作流库移除，不能再编辑、发布或启动。</li>
                  <li>已有运行记录、报告、发布快照及凭据会保留。</li>
                  <li>有运行、自测或助手任务进行中时不能删除。</li>
                </ul>
                {modal.deleteError && <p role="alert" className="error">{modal.deleteError}</p>}
                {deletionPending && <p aria-live="polite">删除请求已提交，正在等待服务端结果，请勿重复操作。</p>}
              </>
            ) : modal.type === "versions" ? (
              <>
                <div className="actions">
                  <button
                    onClick={() =>
                      act(async () => {
                        await api(
                          "/workflows/" + modal.workflow.id + "/disable",
                          "POST",
                          { disabled: modal.workflow.enabled },
                        );
                        setModal(null);
                        await load();
                      })
                    }
                  >
                    {modal.workflow.enabled ? "停用新启动" : "重新启用"}
                  </button>
                </div>
                {modal.value.map((v: J) => (
                  <div className="artifact" key={v.id}>
                    <div>
                      <strong>v{v.version}</strong>
                      {v.version === modal.workflow.defaultVersion && (
                        <Badge tone="green">当前默认</Badge>
                      )}
                      <small>
                        {v.snapshot.workflow.name} ·{" "}
                        {v.snapshot.workflow.environment}
                        {" · "}
                        {v.snapshot.workflow.mode}
                      </small>
                      <small>发布时间：{v.publishedAt}</small>
                      {v.changeNote && <small>变更说明：{v.changeNote}</small>}
                      <small>{v.contentHash}</small>
                    </div>
                    <button
                      onClick={() =>
                        showJson(
                          "已发布定义 v" + v.version,
                          v.snapshot.workflow,
                        )
                      }
                    >
                      查看定义
                    </button>
                    <button
                      onClick={() =>
                        download(
                          v.workflowId + "-v" + v.version + ".json",
                          pretty(v.snapshot.workflow),
                        )
                      }
                    >
                      导出 JSON
                    </button>
                    <button
                      onClick={() =>
                        act(async () =>
                          setModal({
                            type: "comparison",
                            title: "发布版本与当前草稿差异",
                            before: v.snapshot.workflow,
                            after: (
                              await api("/workflows/" + v.workflowId + "/draft")
                            ).draft,
                          }),
                        )
                      }
                    >
                      与草稿比较
                    </button>
                    <button
                      onClick={() =>
                        act(async () => {
                          await api(
                            "/workflows/" +
                              modal.workflow.id +
                              "/select-version",
                            "POST",
                            { version: v.version },
                          );
                          setModal(null);
                          await load();
                        }, "默认版本指针已切换，已有运行保持原快照")
                      }
                    >
                      设为默认
                    </button>
                  </div>
                ))}
              </>
            ) : modal.type === "condition-port" ? (
              <label className="field">
                条件出口
                <select
                  aria-label="条件出口"
                  value={modal.port}
                  onChange={(event) =>
                    setModal({ ...modal, port: event.target.value })
                  }
                >
                  <option
                    value="true"
                    disabled={edges.some(
                      (edge) =>
                        edge.source === modal.connection.source &&
                        edge.data?.port === "true",
                    )}
                  >
                    条件满足（true）
                  </option>
                  <option
                    value="false"
                    disabled={edges.some(
                      (edge) =>
                        edge.source === modal.connection.source &&
                        edge.data?.port === "false",
                    )}
                  >
                    条件不满足（false）
                  </option>
                </select>
              </label>
            ) : modal.type === "publish" ? (
              <>
                <Badge>
                  {modal.workflow.environment} · v{modal.workflow.version} ·
                  revision {modal.revision}
                </Badge>
                <p>
                  发布后保存为不可变版本。以下差异包含环境绑定、节点参数、工具
                  Schema 摘要与资源预算；其他会话修改草稿后，本次确认会被拒绝。
                </p>
                <Field
                  label="变更说明"
                  value={modal.changeNote}
                  onChange={(changeNote) => setModal({ ...modal, changeNote })}
                />
                <p>
                  后端校验：{modal.validation.ok ? "通过" : "未通过"} ·{" "}
                  {modal.validation.nodeCount} 个节点
                </p>
                <ExecutionRequirements requirements={workflowRequirements(modal.workflow)} />
                <ExecutionEvidence evidence={modal.validation.validationEvidence} />
                <DefinitionDiff
                  before={modal.previous}
                  after={modal.workflow}
                />
                <h3>绑定权限与固定资源差异</h3>
                <DefinitionDiff
                  before={modal.previousBindings}
                  after={modal.bindings}
                />
              </>
            ) : modal.type === "comparison" ? (
              <DefinitionDiff before={modal.before} after={modal.after} />
            ) : modal.type === "clients" ? (
              <>
                {modal.value.map((c: J) => (
                  <div className="artifact" key={c.id}>
                    <div>
                      <strong>{c.label}</strong>
                      <small>{c.workflowAllowlist.join(", ")}</small>
                    </div>
                    <button
                      disabled={c.revoked}
                      className="danger"
                      onClick={() =>
                        act(async () => {
                          await api("/clients/" + c.id + "/revoke", "POST", {});
                          setModal({ ...modal, value: await api("/clients") });
                        })
                      }
                    >
                      {c.revoked ? "已撤销" : "撤销"}
                    </button>
                  </div>
                ))}
              </>
            ) : modal.type === "retention" ? (
              <>
                <p>
                  原始结果保留 7 天，到期后清理日志、查询、分析、报告和事件备注，
                  以及助手会话正文、消息、工具收据、自测结果与事件中的业务副本。
                  业务输入与运行元数据保留 30 天，助手与自测元数据也保留 30 天。
                  活跃运行和会话、已保存的测试套件配置、发布版本与能力修订不受影响。
                  会话中存在到期来源时，无法归属任务的历史消息会单独列入正文清理，
                  即使该消息刚刚创建；新消息按实际任务来源判断。
                </p>
                <ul>
                  <li>
                    原始结果与副本：{modal.value.resultRuns.length} 个运行
                  </li>
                  <li>遗留检查点：{modal.value.checkpoints.length} 个运行</li>
                  <li>运行元数据：{modal.value.runs.length} 个运行</li>
                  <li>产物：{modal.value.artifacts.length} 份</li>
                  <li>助手正文到期：{modal.value.assistantResultTasks.length} 个任务、{modal.value.assistantResultMessages.length} 条消息、{modal.value.assistantResultToolCalls.length} 份工具收据、{modal.value.assistantResultSessions.length} 个会话</li>
                  <li>来源到期会话中的历史未归属消息正文：{modal.value.assistantLegacyResultMessages.length} 条</li>
                  <li>助手元数据删除：{modal.value.assistantTasks.length} 个任务、{modal.value.assistantMessages.length} 条消息、{modal.value.assistantToolCalls.length} 份工具收据、{modal.value.assistantSessions.length} 个会话</li>
                  <li>自测：{modal.value.workflowTestResultRuns.length} 份结果到期、{modal.value.workflowTestRuns.length} 条元数据删除</li>
                  <li>应用事件：{modal.value.applicationResultEvents.length} 份正文到期、{modal.value.applicationEvents.length} 条元数据删除</li>
                </ul>
                <details>
                  <summary>查看清理对象 ID</summary>
                  <pre>
                    {pretty({
                      原始结果运行: modal.value.resultRuns,
                      检查点运行: modal.value.checkpoints,
                      元数据运行: modal.value.runs,
                      产物: modal.value.artifacts,
                      助手正文任务: modal.value.assistantResultTasks,
                      助手正文消息: modal.value.assistantResultMessages,
                      历史未归属消息正文: modal.value.assistantLegacyResultMessages,
                      助手正文收据: modal.value.assistantResultToolCalls,
                      助手正文会话: modal.value.assistantResultSessions,
                      助手元数据任务: modal.value.assistantTasks,
                      助手元数据消息: modal.value.assistantMessages,
                      助手元数据收据: modal.value.assistantToolCalls,
                      助手元数据会话: modal.value.assistantSessions,
                      自测结果: modal.value.workflowTestResultRuns,
                      自测元数据: modal.value.workflowTestRuns,
                      应用事件正文: modal.value.applicationResultEvents,
                      应用事件元数据: modal.value.applicationEvents,
                    })}
                  </pre>
                </details>
                <p>已有备份独立保留，不随本次清理删除。此操作无法撤销。</p>
              </>
            ) : modal.type === "detail" ? (
              <>
                <pre>{pretty(modal.value)}</pre>
                <button
                  onClick={() =>
                    download("flowhub-definition.json", pretty(modal.value))
                  }
                >
                  导出 JSON
                </button>
              </>
            ) : modal.type === "new" || modal.type === "save-as" ? (
              <>
                <Field
                  label="工作流名称"
                  value={modal.name}
                  onChange={(v) => setModal({ ...modal, name: v })}
                />
                {modal.errors?.name && (
                  <small className="error">{modal.errors.name}</small>
                )}
                <Field
                  label="工作流 ID"
                  value={modal.slug}
                  onChange={(v) => setModal({ ...modal, slug: v })}
                />
                {modal.errors?.slug && (
                  <small className="error">{modal.errors.slug}</small>
                )}
                <Field
                  label="工作流描述"
                  value={modal.description}
                  onChange={(description) =>
                    setModal({ ...modal, description })
                  }
                />
                <label className="field">
                  固定环境
                  <select
                    value={modal.environment}
                    onChange={(e) =>
                      setModal({ ...modal, environment: e.target.value })
                    }
                  >
                    <option value="">请选择固定环境</option>
                    <option value="staging">试运行</option>
                    <option value="production">生产</option>
                    <option value="test">测试</option>
                  </select>
                </label>
                {modal.errors?.environment && (
                  <small className="error">{modal.errors.environment}</small>
                )}
                {modal.type === "new" && (
                  <label className="field">
                    起始模板
                    <select
                      value={modal.template}
                      onChange={(e) =>
                        setModal({ ...modal, template: e.target.value })
                      }
                    >
                      <option value="blank">空白（输入 → 结束）</option>
                      <option value="incident">
                        问题排查（宿主分析与自动执行）
                      </option>
                      <option value="deterministic">
                        确定性采集（日志 → 结束）
                      </option>
                    </select>
                  </label>
                )}
                {modal.environment === "production" && (
                  <div className="banner">
                    生产流程的环境与资源固定；真实 MCP
                    绑定需证明只读权限并完成独立验证，模拟验证不能授权真实生产。
                  </div>
                )}
                <p>
                  创建未发布草稿，不继承已有流程、凭据或环境绑定。排查与采集模板使用
                  DEMO 输入契约，需明确配置绑定、工具和业务输入后校验发布。
                </p>
              </>
            ) : modal.type === "start" ? (
              <>
                <Badge>
                  {startWorkflow.environment} · v{startWorkflow.version}
                </Badge>
                <p>
                  <strong>{startWorkflow.name}</strong>
                </p>
                <p>{startWorkflow.description}</p>
                <p>
                  执行模式：{startWorkflow.mode}
                  <br />
                  发布时间：{startVersion.publishedAt}
                </p>
                <small>发布摘要：{startVersion.contentHash}</small>
                <label>继续执行的宿主身份
                  <select aria-label="继续执行的宿主身份" value={modal.clientId} onChange={e => setModal({ ...modal, clientId: e.target.value })}>
                    <option value="">本机执行身份</option>
                    {modal.clients.map((c: J) => <option key={c.id} value={c.id}>{c.label ?? c.id}</option>)}
                  </select>
                </label>
                <p>
                  输入严格按已发布 Schema 校验，环境、连接和模板沿用发布版本。
                </p>
                <details>
                  <summary>已发布输入契约</summary>
                  <pre>{pretty(startWorkflow.inputSchema)}</pre>
                </details>
                <JsonEditor
                  label="业务输入"
                  textCache={jsonTextCache.current}
                  cacheKey={"start/" + startWorkflow.workflowId}
                  onValidityChange={reportJsonValidity}
                  value={modal.payload}
                  onChange={(payload) => {
                    setModal({ ...modal, payload });
                    return true;
                  }}
                />
              </>
            ) : modal.type === "unlock" ? (
              <>
                <p>用原口令迁移保存的模型 Key、MCP 凭据和可继续的运行记录。迁移完成后会自动读取。</p>
                <Field
                  label="旧版凭据口令"
                  type="password"
                  value={modal.password}
                  onChange={(password) => setModal({ ...modal, password })}
                />
                {error && failure?.path === "/credentials/migrate" && (
                  <p role="alert" className="error">{error}</p>
                )}
              </>
            ) : ["connection", "edit-connection"].includes(modal.type) ? (
              <ConnectionForm
                value={modal.payload}
                onChange={(payload) => {
                  setModal({ ...modal, payload });
                  return true;
                }}
                onValidityChange={(valid) =>
                  reportJsonValidity("connection-binding-form", valid)
                }
                credentials={credentials}
                connections={connections}
                tools={tools}
                editing={modal.type === "edit-connection"}
                connection={connections.find(
                  (connection) => connection.id === modal.id,
                )}
              />
            ) : ["binding", "edit-binding"].includes(modal.type) ? (
              <>
                {modal.type === "edit-binding" && (
                  <BindingImpact value={modal.impact} />
                )}
                <BindingForm
                  value={modal.payload}
                  onChange={(payload) => {
                    setModal({ ...modal, payload });
                    return true;
                  }}
                  onValidityChange={(valid) =>
                    reportJsonValidity("connection-binding-form", valid)
                  }
                  credentials={credentials}
                  connections={connections}
                  tools={tools}
                  editing={modal.type === "edit-binding"}
                  binding={bindings.find((binding) => binding.id === modal.id)}
                />
              </>
            ) : modal.type === "verify" ? (
              <BindingVerificationForm
                value={modal.payload}
                onChange={(payload) => {
                  setModal({ ...modal, payload });
                  return true;
                }}
                onValidityChange={(valid) =>
                  reportJsonValidity("connection-binding-form", valid)
                }
                binding={bindings.find((binding) => binding.id === modal.id)}
                connections={connections}
                tools={tools}
              />
            ) : modal.type === "revoke-binding" ? (
              <BindingImpact value={modal.impact} />
            ) : modal.type === "workflow-svg" ? (
              <WorkflowSvgPreview svg={modal.diagram.svg} />
            ) : modal.type === "support" ? (
              <>
                <pre>{pretty(modal.content)}</pre>
                <button
                  className="primary"
                  onClick={() =>
                    act(async () => {
                      const x = await api("/support-bundles/export", "POST", {
                        previewHash: modal.hash,
                      });
                      download(x.filename, x.content);
                      setModal(null);
                    })
                  }
                >
                  确认导出这些元数据
                </button>
              </>
            ) : (
              <>
                <JsonEditor
                  label="配置 JSON"
                  textCache={jsonTextCache.current}
                  cacheKey={modal.type + "/" + (draft?.id ?? "configuration")}
                  onValidityChange={reportJsonValidity}
                  onDirty={
                    modal.type === "workflow-config"
                      ? () => setDirty(true)
                      : undefined
                  }
                  validateValue={
                    modal.type === "workflow-config"
                      ? (workflow) => {
                          assertWorkflowShape(workflow);
                          if (workflow.workflowId !== draft.id)
                            throw new Error("工作流 ID 创建后不可修改");
                        }
                      : undefined
                  }
                  value={modal.payload}
                  onChange={(payload) => {
                    setModal({ ...modal, payload });
                    return true;
                  }}
                />
              </>
            )}
            <div className="modal-actions">
              <button disabled={deletionPending} onClick={closeModal}>{modal.type==="delete-workflow"?"取消":"关闭"}</button>
              {modal.type === "workflow-svg" ? (
                <button
                  className="primary"
                  onClick={() =>
                    download(modal.diagram.filename, modal.diagram.svg, "image/svg+xml")
                  }
                >
                  导出 SVG
                </button>
              ) : ![
                "detail",
                "support",
                "clients",
                "versions",
                "comparison",
              ].includes(modal.type) && (
                <button
                  className={modal.type==="delete-workflow"?"danger":"primary"}
                  disabled={
                    busy ||
                    deletionPending ||
                    (jsonInvalid && !["delete-workflow", "unlock"].includes(modal.type)) ||
                    (modal.type === "unlock" && !modal.password) ||
                    (modal.type === "retention" &&
                      !retentionScopeKeys.some(
                        (key) => modal.value[key]?.length,
                      ))
                  }
                  onClick={submitModal}
                >
                  {busy
                    ? "处理中…"
                    : modal.type === "delete-workflow" ? "确认删除" : modal.type === "retention"
                      ? "确认清理"
                      : modal.type === "publish"
                        ? "确认发布"
                        : "确认"}
                </button>
              )}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}
function summarizeBindings(bindings: J[]) {
  return Object.fromEntries(
    bindings
      .filter(Boolean)
      .map((binding) => [
        binding.id,
        Object.fromEntries(
          [
            "id",
            "environment",
            "revision",
            "connectionId",
            "connectionRevision",
            "validationStatus",
            "simulationOnly",
            "allowedTools",
            "allowedQueryTemplates",
            "lockedArguments",
            "maxRows",
            "timeoutSeconds",
            "verification",
          ].map((key) => [key, binding[key]]),
        ),
      ]),
  );
}
function BindingImpact({ value }: { value: J }) {
  if (!value) return <p>影响范围尚未加载，不能确认修改。</p>;
  return (
    <section className="binding-impact">
      <h3>修改影响预览</h3>
      <p>
        绑定 {value.bindingId} · 修订 {value.revision}：
        {value.summary.draftWorkflows} 个草稿、{value.summary.publishedVersions}{" "}
        个发布版本、{value.summary.activeRuns} 个活跃运行。
      </p>
      <p>
        变更后验证失效，引用旧绑定的版本需要重新发布；活跃运行的后续执行准入会阻断。在途调用的结果仍需单独确认。
      </p>
      <details>
        <summary>查看受影响流程与运行</summary>
        <pre>
          {pretty({
            draftWorkflows: value.draftWorkflows,
            publishedVersions: value.publishedVersions,
            activeRuns: value.activeRuns,
          })}
        </pre>
      </details>
    </section>
  );
}
function DefinitionDiff({ before, after }: { before: J; after: J }) {
  const rows: { pointer: string; before: J; after: J }[] = [];
  const compare = (left: J, right: J, pointer = "") => {
    if (JSON.stringify(left) === JSON.stringify(right)) return;
    if (isObject(left) && isObject(right)) {
      for (const key of new Set([...Object.keys(left), ...Object.keys(right)]))
        compare(
          left[key],
          right[key],
          pointer + "/" + key.replaceAll("~", "~0").replaceAll("/", "~1"),
        );
    } else rows.push({ pointer: pointer || "/", before: left, after: right });
  };
  compare(before, after);
  return (
    <div className="definition-diff">
      {!rows.length ? (
        <p>定义相同，没有差异。</p>
      ) : (
        rows.map((row) => (
          <details key={row.pointer} open={rows.length < 5}>
            <summary>{row.pointer}</summary>
            <div className="diff-columns">
              <div>
                <strong>已保存版本 / 服务端</strong>
                <pre>
                  {row.before === undefined ? "（无）" : pretty(row.before)}
                </pre>
              </div>
              <div>
                <strong>当前草稿 / 本地</strong>
                <pre>
                  {row.after === undefined ? "（无）" : pretty(row.after)}
                </pre>
              </div>
            </div>
          </details>
        ))
      )}
    </div>
  );
}
function graphIssues(workflow: J) {
  const issues: J[] = [];
  const ids = new Set<string>(),
    seen = new Set<string>(),
    active = new Set<string>();
  const add = (
    nodeId: string | undefined,
    message: string,
    code = "GRAPH_INVALID",
  ) => issues.push({ code, severity: "error", nodeId, message });
  for (const node of workflow.nodes) {
    if (ids.has(node.id)) add(node.id, "节点 ID 重复");
    ids.add(node.id);
    const exits = workflow.edges.filter((edge: J) => edge.source === node.id);
    if (
      node.type === "condition"
        ? exits.length !== 2 ||
          new Set(exits.map((edge: J) => edge.port)).size !== 2 ||
          exits.some((edge: J) => !["true", "false"].includes(edge.port))
        : node.type === "end"
          ? exits.length !== 0
          : exits.length !== 1 || exits[0]?.port !== "next"
    )
      add(node.id, "出口数量或互斥分支标记不完整");
  }
  for (const edge of workflow.edges)
    if (!ids.has(edge.source) || !ids.has(edge.target))
      add(
        ids.has(edge.source) ? edge.source : edge.target,
        "连线引用不存在的节点",
      );
  const starts = workflow.nodes.filter((node: J) => node.type === "input"),
    ends = workflow.nodes.filter((node: J) => node.type === "end");
  if (starts.length !== 1) add(starts[0]?.id, "需要且只能有一个输入节点");
  if (ends.length !== 1) add(ends[0]?.id, "需要且只能有一个结束节点");
  const visit = (id: string) => {
    if (active.has(id)) {
      add(id, "不支持循环或回边", "GRAPH_CYCLE");
      return;
    }
    if (seen.has(id)) return;
    seen.add(id);
    active.add(id);
    for (const edge of workflow.edges.filter(
      (edge: J) => edge.source === id && ids.has(edge.target),
    ))
      visit(edge.target);
    active.delete(id);
  };
  if (starts[0]) visit(starts[0].id);
  for (const id of ids) if (!seen.has(id)) add(id, "节点未连接到输入链路");
  return issues;
}
function Field({
  label,
  value,
  onChange,
  type = "text",
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
}) {
  return (
    <label className="field">
      {label}
      <input
        type={type}
        value={value}
        autoComplete={type === "password" ? "new-password" : "off"}
        onChange={(e) => onChange(e.target.value)}
      />
    </label>
  );
}
function PageHead({
  eyebrow,
  title,
  text,
  children,
}: {
  eyebrow: string;
  title: string;
  text: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <small className="eyebrow">{eyebrow}</small>
        <h1>{title}</h1>
        <p>{text}</p>
      </div>
      <div className="actions">{children}</div>
    </div>
  );
}
function Empty({ text }: { text: string }) {
  return (
    <div className="empty">
      <span>◇</span>
      <p>{text}</p>
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);

type SchemaField = {
  pointer: string;
  type: string;
  required: boolean;
  schema: J;
};
function valueAtPointer(value: J, pointer: string) {
  const parts = pointer ? pointer.slice(1).split("/") : [];
  for (const part of parts) {
    const key = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!value || typeof value !== "object" || !Object.hasOwn(value, key)) return undefined;
    value = value[key];
  }
  return value;
}
function schemaFields(root: J): SchemaField[] {
  const fields: SchemaField[] = [];
  function visit(schema: J, pointer: string, required: boolean, seen: Set<string>, depth: number) {
    if (!isObject(schema) || depth >= 24 || fields.length >= 1024) return;
    if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/") && !seen.has(schema.$ref)) {
      let target: J;
      try { target = valueAtPointer(root, decodeURIComponent(schema.$ref.slice(1))); }
      catch { return; }
      const { $ref, ...annotations } = schema;
      if (isObject(target)) {
        visit({ ...target, ...annotations }, pointer, required, new Set([...seen, $ref]), depth + 1);
        return;
      }
    }
    const types = (Array.isArray(schema.type) ? schema.type : [schema.type])
      .filter((type: unknown): type is string => typeof type === "string");
    fields.push({ pointer, type: types.join(" / ") || "unknown", required, schema });
    const guaranteed = required && types.length === 1;
    if (types.includes("object") && isObject(schema.properties)) {
      const requiredNames = Array.isArray(schema.required) ? schema.required : [];
      for (const [name, child] of Object.entries(schema.properties))
        visit(child, pointer + "/" + name.replaceAll("~", "~0").replaceAll("/", "~1"),
          guaranteed && requiredNames.includes(name), seen, depth + 1);
    }
    if (types.includes("array")) {
      const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
      const minimum = Number.isSafeInteger(schema.minItems) ? schema.minItems : 0;
      const count = Math.min(Math.max(minimum, prefix.length), 16);
      for (let index = 0; index < count; index++)
        visit(prefix[index] ?? schema.items, pointer + "/" + index,
          guaranteed && index < minimum, seen, depth + 1);
    }
  }
  visit(root, "", true, new Set(), 0);
  return fields;
}
function mandatoryNodes(workflow: J, targetId: string): Set<string> {
  const ids = new Set<string>(workflow.nodes.map((n: J) => n.id));
  const start = workflow.nodes.find((n: J) => n.type === "input")?.id;
  if (!start) return new Set();
  const dominators = new Map<string, Set<string>>(
    [...ids].map((id) => [id, id === start ? new Set([id]) : new Set(ids)]),
  );
  for (let pass = 0; pass < ids.size; pass++) {
    let changed = false;
    for (const id of ids) {
      if (id === start) continue;
      const parents: string[] = workflow.edges
        .filter((edge: J) => edge.target === id && ids.has(edge.source))
        .map((edge: J) => edge.source);
      const next = new Set<string>(
        parents.length
          ? [...dominators.get(parents[0])!].filter((ancestor) =>
              parents.every((parent) => dominators.get(parent)!.has(ancestor)),
            )
          : [],
      );
      next.add(id);
      if (
        [...next].some((item) => !dominators.get(id)!.has(item)) ||
        next.size !== dominators.get(id)!.size
      )
        changed = true;
      dominators.set(id, next);
    }
    if (!changed) break;
  }
  const result = new Set(dominators.get(targetId) ?? []);
  result.delete(targetId);
  return result;
}
function LiteralField({
  value,
  label,
  onChange,
  onValidityChange,
  onDirty,
}: {
  value: J;
  label: string;
  onChange: (value: J) => void;
  onValidityChange: (label: string, valid: boolean) => void;
  onDirty: () => void;
}) {
  const persistence = useContext(EditorTextContext);
  const key = literalTextKey(persistence, label);
  const [text, setText] = useState(
    persistence?.cache.get(key) ?? JSON.stringify(value),
  );
  const [error, setError] = useState("");
  useEffect(() => {
    const cached = persistence?.cache.get(key);
    setText(cached ?? JSON.stringify(value));
    if (cached !== undefined) {
      setError("此常量仍有未应用文本，请修正后保存");
      onValidityChange(key, false);
    }
  }, [value, key]);
  useEffect(() => () => onValidityChange(key, true), [key, onValidityChange]);
  return (
    <label className="field">
      {label}
      <input
        aria-label={label}
        value={text}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (persistence) cacheText(persistence.cache, key, next);
          onDirty();
          try {
            const parsed = JSON.parse(next);
            onValidityChange(key, true);
            setError("");
            onChange(parsed);
            persistence?.cache.delete(key);
          } catch {
            onValidityChange(key, false);
            setError('常量必须是合法 JSON 值，例如 "order-by-number-v1"');
          }
        }}
      />
      {error && <small className="error">{error}</small>}
    </label>
  );
}
function literalTextKey(editor: React.ContextType<typeof EditorTextContext>, label: string) {
  return editor ? editor.scope + "/literal/" + label : label;
}
function hostReceiptHint(code: string) {
  return ({
    AUTH_REQUIRED: "等待恢复 Codex 授权。恢复后可继续当前运行。",
    HOST_CAPABILITY_UNAVAILABLE: "等待恢复 Codex 工具。确认当前会话可调用该工具后继续。",
    HOST_CONTRACT_MISMATCH: "工具契约已变化。请同步 Codex 目录，更新草稿并重新发布。",
    HOST_RECEIPT_SCHEMA_INVALID: "回执与发布契约不符。请使用已取得的原始结果修正回执。",
    OUTCOME_UNKNOWN: "调用结果未知。请对照工具或服务端记录确认结果。",
  } as Record<string, string>)[code];
}

function exampleAt(schema: J, pointer: string, field?: SchemaField) {
  if (field?.schema.examples?.length) return field.schema.examples[0];
  return valueAtPointer(schema?.examples?.[0], pointer);
}

function ReceiptScopeFields({ value, inputSchema, outputSchema, onChange }: {
  value: Record<string, string>;
  inputSchema: J;
  outputSchema: J;
  onChange: (value: Record<string, string>) => void;
}) {
  const [output, setOutput] = useState("");
  const [input, setInput] = useState("");
  const outputs = schemaFields(outputSchema).filter(field => validMappingPointer(field.pointer) && field.required && !Object.hasOwn(value, field.pointer));
  const inputs = schemaFields(inputSchema).filter(field => validMappingPointer(field.pointer) && field.required);
  const limitReached = Object.keys(value).length >= 16;
  return (
    <details className="mapping-form">
      <summary>回执范围字段</summary>
      <p>为工具结果中返回的订单号、资源或时间范围指定对应的调用参数，回执校验时会逐项比对。</p>
      {Object.keys(value).length === 0 && <small>未配置回执范围比对。</small>}
      {Object.entries(value).map(([pointer, argument]) => (
        <div className="mapping-row" key={pointer}>
          <div className="row">
            <code>{pointer} ← {argument}</code>
            <button aria-label={"移除范围比对 " + pointer} onClick={() => {
              const remaining = { ...value };
              delete remaining[pointer];
              onChange(remaining);
            }}>×</button>
          </div>
        </div>
      ))}
      {limitReached && <small>已添加 16 条范围比对。</small>}
      {!limitReached && outputs.length > 0 && inputs.length > 0 && <>
        <label className="field">
          回执输出字段
          <select aria-label="回执输出字段" value={output} onChange={(event) => setOutput(event.target.value)}>
            <option value="">选择必填输出字段</option>
            {outputs.map(field => <option key={field.pointer} value={field.pointer}>{field.pointer} · {field.type}</option>)}
          </select>
        </label>
        <label className="field">
          对应调用参数
          <select aria-label="对应调用参数" value={input} onChange={(event) => setInput(event.target.value)}>
            <option value="">选择必填调用参数</option>
            {inputs.map(field => <option key={field.pointer} value={field.pointer}>{field.pointer} · {field.type}</option>)}
          </select>
        </label>
        <button
          disabled={!outputs.some(field => field.pointer === output) || !inputs.some(field => field.pointer === input)}
          onClick={() => { onChange({ ...value, [output]: input }); setOutput(""); setInput(""); }}
        >添加范围比对</button>
      </>}
    </details>
  );
}

function validMappingPointer(pointer: string) {
  return pointer.length <= 512 && /^(?:\/(?:[^~/]|~[01])*)+$/.test(pointer) &&
    !pointer.split("/").some(part => ["__proto__", "prototype", "constructor"].includes(part));
}

function pointerOverlap(left: string, right: string) {
  return left === right || left.startsWith(right + "/") || right.startsWith(left + "/");
}

type SourceNode = { id: string; title: string; schema: J };
function ReferenceFields({
  value,
  label,
  inputSchema,
  sourceNodes,
  onChange,
}: {
  value: J;
  label: string;
  inputSchema: J;
  sourceNodes: SourceNode[];
  onChange: (value: J) => void;
}) {
  const sourceSchema =
    value.source === "input"
      ? inputSchema
      : sourceNodes.find((node) => node.id === value.nodeId)?.schema;
  const fields = schemaFields(sourceSchema);
  const selectedField = fields.find((field) => field.pointer === value.pointer);
  const example = exampleAt(sourceSchema, value.pointer, selectedField);
  return (
    <>
      {value.source === "node" && (
        <label className="field">
          {label} 前序节点
          <select
            aria-label={label + " 前序节点"}
            value={value.nodeId ?? ""}
            onChange={(event) =>
              onChange({ ...value, nodeId: event.target.value, pointer: "" })
            }
          >
            <option value="" disabled>
              选择必经前序节点
            </option>
            {sourceNodes.map((node) => (
              <option key={node.id} value={node.id}>
                {node.title} · {node.id}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        {label} 可用字段
        <select
          aria-label={label + " 可用字段"}
          value={value.pointer}
          onChange={(event) =>
            onChange({ ...value, pointer: event.target.value })
          }
        >
          {!selectedField && (
            <option value={value.pointer}>未声明字段 {value.pointer}</option>
          )}
          {fields.map((field) => (
            <option key={field.pointer} value={field.pointer}>
              {field.pointer || "整个对象"} · {field.type} ·{" "}
              {field.required ? "必填" : "可能缺失"}
            </option>
          ))}
        </select>
      </label>
      {selectedField && (
        <small>
          类型：{selectedField.type} ·{" "}
          {selectedField.required
            ? "契约声明必填"
            : "字段可能缺失，请检查下游必填约束"}{" "}
          {example !== undefined && " · 样例值 " + JSON.stringify(example)}
        </small>
      )}
    </>
  );
}
function MappingFields({
  value,
  onChange,
  nodeId,
  inputSchema,
  sourceNodes,
  targetSchema,
  lockedArguments,
  onValidityChange,
  onDirty,
}: {
  value: J;
  onChange: (v: J) => void;
  nodeId: string;
  inputSchema: J;
  sourceNodes: SourceNode[];
  targetSchema?: J;
  lockedArguments: J;
  onValidityChange: (label: string, valid: boolean) => void;
  onDirty: () => void;
}) {
  const [target, setTarget] = useState("");
  const [error, setError] = useState("");
  const editor = useContext(EditorTextContext);
  const discardLiteral = (pointer: string) => {
    const key = literalTextKey(editor, pointer + " 常量");
    editor?.cache.delete(key);
    onValidityChange(key, true);
  };
  const locked = Object.keys(lockedArguments);
  const mapped = Object.keys(value);
  const fields = schemaFields(targetSchema).filter(field => validMappingPointer(field.pointer) &&
    !locked.some(path => pointerOverlap(field.pointer, path)));
  const fieldsByPointer = new Map(fields.map((field) => [field.pointer, field]));
  const missing = fields.filter((field) => field.required &&
    !mapped.some(path => pointerOverlap(field.pointer, path)));
  const patch = (key: string, expression: J) =>
    onChange({ ...value, [key]: expression });
  return (
    <section className="mapping-form">
      <h3>参数映射</h3>
      <small>
        来源只列工作流输入与必经前序节点；绑定锁定参数不能添加映射。
      </small>
      {missing.length > 0 && (
        <p className="error">仍有必填工具参数未映射：{missing.map((field) => field.pointer).join("、")}</p>
      )}
      {Object.entries(value).map(([key, expression]: [string, J]) => (
        <div className="mapping-row" key={nodeId + ":" + key}>
          <div className="row">
            <code>{key}</code>
            {fieldsByPointer.get(key) && <small>{fieldsByPointer.get(key)?.type}
              {" · "}{fieldsByPointer.get(key)?.required ? "必填" : "可选"}</small>}
            <button
              aria-label={"移除映射 " + key}
              onClick={() => {
                discardLiteral(key);
                const next = { ...value };
                delete next[key];
                onChange(next);
              }}
            >
              ×
            </button>
          </div>
          <select
            aria-label={key + " 来源"}
            value={expression.ref?.source ?? "literal"}
            onChange={(event) => {
              if (!expression.ref) discardLiteral(key);
              patch(
                key,
                event.target.value === "literal"
                  ? { value: "" }
                  : {
                      ref: {
                        source: event.target.value,
                        pointer: "",
                        ...(event.target.value === "node"
                          ? { nodeId: sourceNodes[0]?.id ?? "" }
                          : {}),
                      },
                    },
              );
            }}
          >
            <option value="literal">固定常量</option>
            <option value="input">工作流输入</option>
            <option value="node" disabled={!sourceNodes.length}>
              前序节点输出
            </option>
          </select>
          <small>{expression.ref ? "值由运行时输入或前序结果解析" : "样例值 " + JSON.stringify(expression.value)}</small>
          {expression.ref ? (
            <ReferenceFields
              value={expression.ref}
              label={key}
              inputSchema={inputSchema}
              sourceNodes={sourceNodes}
              onChange={(ref) => patch(key, { ref })}
            />
          ) : (
            <LiteralField
              value={expression.value}
              label={key + " 常量"}
              onChange={(literal) => patch(key, { value: literal })}
              onValidityChange={onValidityChange}
              onDirty={onDirty}
            />
          )}
        </div>
      ))}
      <label className="field">
        目标参数
        {targetSchema && fields.length ? (
          <select
            aria-label="目标参数"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          >
            <option value="">按工具 Schema 选择字段</option>
            {fields
              .filter((field) => !mapped.some(path => pointerOverlap(field.pointer, path)))
              .map((field) => (
                <option key={field.pointer} value={field.pointer}>
                  {field.pointer} · {field.type}{" "}
                  {field.required ? "（必填）" : ""}
                </option>
              ))}
          </select>
        ) : (
          <input
            aria-label="目标参数"
            placeholder="/question"
            value={target}
            onChange={(event) => setTarget(event.target.value)}
          />
        )}
      </label>
      {error && <p className="error">{error}</p>}
      <button
        onClick={() => {
          if (!validMappingPointer(target)) {
            setError("请选择合法目标字段");
            return;
          }
          if ([...locked, ...mapped].some(path => pointerOverlap(target, path))) {
            setError("目标字段与已锁定或已有映射的参数重叠");
            return;
          }
          patch(target, { ref: { source: "input", pointer: "" } });
          setTarget("");
          setError("");
        }}
      >
        ＋ 添加参数映射
      </button>
    </section>
  );
}
function ExpressionFields({
  value,
  label,
  inputSchema,
  sourceNodes,
  onChange,
  onValidityChange,
  onDirty,
}: {
  value: J;
  label: string;
  inputSchema: J;
  sourceNodes: SourceNode[];
  onChange: (value: J) => void;
  onValidityChange: (label: string, valid: boolean) => void;
  onDirty: () => void;
}) {
  return (
    <>
      <label className="field">
        {label} 来源
        <select
          aria-label={label + " 来源"}
          value={value.ref?.source ?? "literal"}
          onChange={(event) =>
            onChange(
              event.target.value === "literal"
                ? { value: true }
                : {
                    ref: {
                      source: event.target.value,
                      pointer: "",
                      ...(event.target.value === "node"
                        ? { nodeId: sourceNodes[0]?.id ?? "" }
                        : {}),
                    },
                  },
            )
          }
        >
          <option value="input">工作流输入</option>
          <option value="node" disabled={!sourceNodes.length}>
            前序节点输出
          </option>
          <option value="literal">固定常量</option>
        </select>
      </label>
      {value.ref ? (
        <ReferenceFields
          value={value.ref}
          label={label}
          inputSchema={inputSchema}
          sourceNodes={sourceNodes}
          onChange={(ref) => onChange({ ref })}
        />
      ) : (
        <LiteralField
          value={value.value}
          label={label + " 常量"}
          onChange={(literal) => onChange({ value: literal })}
          onValidityChange={onValidityChange}
          onDirty={onDirty}
        />
      )}
    </>
  );
}
function ConditionFields({
  value,
  onChange,
  inputSchema,
  sourceNodes,
  onValidityChange,
  onDirty,
  depth = 0,
  path = "condition",
}: {
  value: J;
  onChange: (value: J) => void;
  inputSchema: J;
  sourceNodes: SourceNode[];
  onValidityChange: (label: string, valid: boolean) => void;
  onDirty: () => void;
  depth?: number;
  path?: string;
}) {
  const op = value.op;
  const shared = { inputSchema, sourceNodes, onValidityChange, onDirty };
  return (
    <section className="condition-form">
      <h3>{depth ? "子条件" : "互斥条件"}</h3>
      <label className="field">
        比较方式
        <select
          aria-label={"条件比较方式 " + path}
          value={op}
          onChange={(event) =>
            onChange(
              event.target.value === "eq"
                ? {
                    op: "eq",
                    left: { ref: { source: "input", pointer: "" } },
                    right: { value: true },
                  }
                : event.target.value === "exists"
                  ? {
                      op: "exists",
                      value: { ref: { source: "input", pointer: "" } },
                    }
                  : {
                      op: event.target.value,
                      args: [
                        {
                          op: "eq",
                          left: { value: true },
                          right: { value: true },
                        },
                        {
                          op: "eq",
                          left: { value: true },
                          right: { value: true },
                        },
                      ],
                    },
            )
          }
        >
          <option value="eq">等于</option>
          <option value="exists">字段存在</option>
          <option value="and" disabled={depth >= 3}>
            全部满足 AND
          </option>
          <option value="or" disabled={depth >= 3}>
            任一满足 OR
          </option>
        </select>
      </label>
      {op === "eq" ? (
        <>
          <ExpressionFields
            {...shared}
            value={value.left}
            label={"条件左值 " + path}
            onChange={(left) => onChange({ ...value, left })}
          />
          <ExpressionFields
            {...shared}
            value={value.right}
            label={"条件右值 " + path}
            onChange={(right) => onChange({ ...value, right })}
          />
        </>
      ) : op === "exists" ? (
        <ExpressionFields
          {...shared}
          value={value.value}
          label={"存在字段 " + path}
          onChange={(expression) => onChange({ ...value, value: expression })}
        />
      ) : (
        value.args.map((argument: J, index: number) => (
          <ConditionFields
            key={index}
            {...shared}
            value={argument}
            depth={depth + 1}
            path={path + "." + index}
            onChange={(next) =>
              onChange({
                ...value,
                args: value.args.map((old: J, at: number) =>
                  at === index ? next : old,
                ),
              })
            }
          />
        ))
      )}
      {!depth && (
        <small>
          只生成有限条件 AST；出口 true 为“条件满足”，false 为“条件不满足”。
        </small>
      )}
    </section>
  );
}
