import React, { useEffect, useState, useCallback } from "react";
import { createRoot } from "react-dom/client";
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  applyNodeChanges,
  addEdge,
  type Node,
  type Edge,
  type NodeChange,
  type Connection,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import "./style.css";
type J = any;
let csrf = "";
async function api(
  path: string,
  method = "GET",
  body?: J,
  revision?: number,
): Promise<J> {
  const response = await fetch("/api/v1" + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...(method !== "GET" ? { "X-CSRF-Token": csrf } : {}),
      ...(revision !== undefined ? { "If-Match": String(revision) } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const value = await response.json();
  if (!response.ok)
    throw new Error(
      (value.error?.code ?? response.status) +
        "：" +
        (value.error?.message ?? "请求失败"),
    );
  return value.data;
}
const pretty = (v: J) => JSON.stringify(v, null, 2);
const uid = () => crypto.randomUUID();
const labels: Record<string, string> = {
  input: "接收输入",
  mcp_tool: "MCP 工具",
  agent_task: "Codex 任务",
  condition: "条件分支",
  approval: "人工审批",
  report_template: "模板报告",
  end: "结束归档",
};
const glyph: Record<string, string> = {
  workflows: "▦",
  editor: "◇",
  connections: "⌘",
  bindings: "▤",
  runs: "◷",
  settings: "⚙",
  input: "↳",
  mcp_tool: "☁",
  agent_task: "✧",
  condition: "⑂",
  approval: "✓",
  report_template: "▧",
  end: "◎",
};
const statusLabels: Record<string, string> = {
  SUCCEEDED: "已完成",
  WAITING_AGENT: "等待 Agent",
  WAITING_APPROVAL: "等待人工审批",
  BLOCKED: "已阻断",
  OUTCOME_UNKNOWN: "结果未知",
  FAILED: "失败",
  CANCELLED: "已取消",
  RUNNING: "执行中",
  QUEUED: "排队中",
  REJECTED: "已拒绝",
};
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
}: {
  value: J;
  onChange: (v: J) => void;
  label?: string;
}) {
  const [text, setText] = useState(pretty(value)),
    [error, setError] = useState("");
  useEffect(() => {
    setText(pretty(value));
    setError("");
  }, [value]);
  return (
    <label className="field">
      {label}
      <textarea
        aria-label={label}
        spellCheck={false}
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          try {
            const v = JSON.parse(text);
            onChange(v);
            setError("");
          } catch {
            setError("JSON 格式错误，尚未应用");
          }
        }}
      />
      {error && <small className="error">{error}</small>}
    </label>
  );
}
function App() {
  const [path, setPath] = useState(
      location.pathname === "/" ? "/workflows" : location.pathname,
    ),
    [session, setSession] = useState<J>(null),
    [auth, setAuth] = useState<J>(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [setupToken, setSetupToken] = useState("");
  const [workflows, setWorkflows] = useState<J[]>([]),
    [connections, setConnections] = useState<J[]>([]),
    [bindings, setBindings] = useState<J[]>([]),
    [runs, setRuns] = useState<J[]>([]),
    [tools, setTools] = useState<J[]>([]);
  const [filter, setFilter] = useState("all"),
    [query, setQuery] = useState(""),
    [modal, setModal] = useState<J>(null),
    [draft, setDraft] = useState<J>(null),
    [dirty, setDirty] = useState(false),
    [selected, setSelected] = useState<string | null>(null),
    [run, setRun] = useState<J>(null),
    [artifact, setArtifact] = useState<J>(null);
  const [nodes, setNodes] = useState<Node[]>([]),
    [edges, setEdges] = useState<Edge[]>([]);
  const act = useCallback(async (fn: () => Promise<J>, message?: string) => {
    setError("");
    setBusy(true);
    try {
      const result = await fn();
      if (message) setNotice(message);
      return result;
    } catch (e) {
      setError(String((e as Error).message));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  const load = useCallback(async () => {
    const [w, c, b, r, t] = await Promise.all(
      ["/workflows", "/connections", "/bindings", "/runs", "/tools"].map((p) =>
        api(p),
      ),
    );
    setWorkflows(w);
    setConnections(c);
    setBindings(b);
    setRuns(r);
    setTools(t);
  }, []);
  const navigate = (next: string) => {
    if (dirty && !confirm("草稿有未保存修改，是否离开？")) return;
    setDirty(false);
    history.pushState({}, "", next);
    setPath(next);
    setArtifact(null);
  };
  useEffect(() => {
    const pop = () => {
      setPath(location.pathname);
      setDirty(false);
    };
    window.addEventListener("popstate", pop);
    void act(async () => {
      const a = await api("/auth/state");
      setAuth(a);
      if (a.initialized) {
        try {
          const s = await api("/auth/session");
          csrf = s.csrf;
          setSession(s);
        } catch {}
      }
    });
    return () => window.removeEventListener("popstate", pop);
  }, []);
  useEffect(() => {
    if (session) void act(load);
  }, [session]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(""), 5000);
    return () => clearTimeout(t);
  }, [notice]);
  useEffect(() => {
    const listener = (e: BeforeUnloadEvent) => {
      if (dirty) e.preventDefault();
    };
    window.addEventListener("beforeunload", listener);
    return () => window.removeEventListener("beforeunload", listener);
  }, [dirty]);
  const buildCanvas = (record: J) => {
    setDraft(record);
    setSelected(null);
    setNodes(
      record.draft.nodes.map((n: J, i: number) => ({
        id: n.id,
        type: "default",
        position: record.layout[n.id] ?? {
          x: n.type === "approval" ? 80 : 230,
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
          width: 260,
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
        label: e.port === "next" ? "" : e.port,
        type: "smoothstep",
        data: { port: e.port },
        style: { stroke: "#8eafd9", strokeWidth: 2 },
      })),
    );
  };
  useEffect(() => {
    if (!session) return;
    if (/\/workflows\/[^/]+\/editor/.test(path)) {
      const key = path.split("/")[2];
      void act(async () =>
        buildCanvas(await api("/workflows/" + key + "/draft")),
      );
    }
    if (/^\/runs\/[^/]+$/.test(path)) {
      const key = path.split("/")[2];
      const refresh = async () => {
        try {
          setRun(await api("/runs/" + key));
        } catch (e) {
          setError((e as Error).message);
        }
      };
      void refresh();
      const timer = setInterval(refresh, 2000);
      return () => clearInterval(timer);
    }
  }, [path, session]);
  const refreshRun = async () => {
    if (run) setRun(await api("/runs/" + run.runId));
    await load();
  };
  const save = async () => {
    if (!draft) return;
    const layout = Object.fromEntries(nodes.map((n) => [n.id, n.position]));
    const workflow = {
      ...draft.draft,
      edges: edges.map((e) => ({
        source: e.source,
        target: e.target,
        port: e.data?.port ?? e.label ?? "next",
      })),
    };
    const result = await api(
      "/workflows/" + workflow.workflowId + "/draft",
      "PUT",
      { workflow, layout },
      draft.revision,
    );
    setDraft(result);
    setDirty(false);
    await load();
    return result;
  };
  const changeNode = (patch: J) => {
    setDraft((old: J) => ({
      ...old,
      draft: {
        ...old.draft,
        nodes: old.draft.nodes.map((n: J) =>
          n.id === selected ? { ...n, ...patch } : n,
        ),
      },
    }));
    setDirty(true);
  };
  const chooseWorkflow = (w: J) => navigate("/workflows/" + w.id + "/editor");
  const openStart = (w: J) =>
    act(async () => {
      const versions = await api("/workflows/" + w.id + "/versions");
      const published = versions.find(
        (v: J) => v.workflowId === w.id && v.version === w.defaultVersion,
      );
      const workflow = published?.snapshot?.workflow;
      if (
        !w.defaultVersion ||
        !workflow ||
        workflow.workflowId !== w.id ||
        workflow.version !== published.version
      )
        throw new Error("已发布默认版本不可用，请刷新工作流后重试");
      setModal({
        type: "start",
        title: "启动工作流",
        published,
        payload: structuredClone(workflow.inputSchema.examples?.[0] ?? {}),
      });
    });
  const showJson = (title: string, value: J) =>
    setModal({ type: "detail", title, value });
  const startVersion = modal?.type === "start" ? modal.published : null;
  const startWorkflow = startVersion?.snapshot.workflow;
  const node = draft?.draft.nodes.find((n: J) => n.id === selected);
  const nodeDefaults: Record<string, J> = {
    input: {},
    end: { resultRef: { ref: { source: "input", pointer: "" } } },
    mcp_tool: {
      bindingKey: "log",
      toolName: "",
      toolSchemaHash: "",
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
    approval: {
      actionNodeId: "db",
      summary: "请核对固定环境、资源和参数",
      approvalChannel: "admin_ui",
      bindToResolvedArguments: true,
      invalidateOnArgumentChange: true,
      expiresAfterSeconds: 600,
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
    const m = modal;
    await act(async () => {
      if (m.type === "start") {
        const workflow = m.published.snapshot.workflow;
        const r = await api("/runs", "POST", {
          workflowId: workflow.workflowId,
          version: workflow.version,
          mode: workflow.mode,
          inputs: m.payload,
          idempotencyKey: uid(),
        });
        setModal(null);
        await load();
        navigate("/runs/" + r.runId);
        return;
      }
      if (m.type === "new") {
        const base = structuredClone(workflows[0].draft);
        base.workflowId = m.slug;
        base.name = m.name;
        base.version = "1.0.0";
        const env = m.environment ?? "staging";
        const template = workflows.find((w) => w.environment === env);
        base.environment = env;
        base.bindings = structuredClone(template.draft.bindings);
        for (const n of base.nodes)
          if (n.type === "mcp_tool") {
            const original = template.draft.nodes.find((x: J) => x.id === n.id);
            n.config = structuredClone(original.config);
          }
        await api("/workflows", "POST", { workflow: base });
        setModal(null);
        await load();
        navigate("/workflows/" + base.workflowId + "/editor");
        return;
      }
      if (m.type === "workflow-config") {
        buildCanvas({
          ...draft,
          draft: m.payload,
          layout: Object.fromEntries(nodes.map((n) => [n.id, n.position])),
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
      if (m.type === "rotate") {
        await api("/vault/password", "POST", m.payload);
      }
      if (m.type === "secret") {
        await api("/secrets", "POST", { label: m.label, value: m.value });
      }
      if (m.type === "unlock") {
        await api("/vault/unlock", "POST", { password: m.password });
        setAuth({ ...auth, vaultLocked: false });
      }
      if (m.type === "agent") {
        const cp = run.checkpoint;
        await api("/runs/" + run.runId + "/advance", "POST", {
          runId: run.runId,
          checkpointId: cp.id,
          checkpointToken: cp.token,
          expectedRevision: run.revision,
          idempotencyKey: uid(),
          submission: { type: "agent_result", payload: m.payload },
        });
        await refreshRun();
      }
      if (m.type === "retention") {
        const result = await api("/retention/commit", "POST", {
          previewHash: m.value.hash,
        });
        setNotice(
          `清理完成：${result.expiredResultRuns} 个运行的原始结果，${result.deletedArtifacts} 份产物，${result.deletedRuns} 个运行的元数据`,
        );
      }
      if (m.type === "import") {
        await api("/workflow-imports/preview", "POST", { workflow: m.payload });
        await api("/workflow-imports/commit", "POST", { workflow: m.payload });
      }
      setModal(null);
      await load();
      return true;
    }, "操作已完成");
  };
  const approve = async (decision: string) => {
    await act(
      async () => {
        await api("/approvals/" + run.approval.id + "/decision", "POST", {
          decision,
          actionHash: run.approval.actionHash,
          snapshotHash: run.snapshotHash,
          expectedRevision: run.revision,
        });
        await refreshRun();
      },
      decision === "approve"
        ? "已批准此版本及参数的动作"
        : "已拒绝，数据库不会执行",
    );
  };
  const page = path.includes("/editor")
    ? "editor"
    : (path.split("/")[1] ?? "workflows");
  if (!session)
    return (
      <div className="login">
        <div className="login-card">
          <div className="brand">
            <b>F</b>FlowHub <small>LOCAL WORKFLOW HUB</small>
          </div>
          <h1>{auth?.initialized ? "欢迎回来" : "创建本机管理员"}</h1>
          <p>一个 MCP 入口，多条受控工作流。管理会话独立于 Agent 执行身份。</p>
          {!auth?.initialized && (
            <label className="field">
              本机一次性设置码
              <input
                autoComplete="off"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
              />
              <small>
                在数据目录的 admin-setup-token 文件中查看；不会出现在日志或 URL
                中。
              </small>
            </label>
          )}
          <label className="field">
            管理员密码
            <input
              type="password"
              autoComplete={
                auth?.initialized ? "current-password" : "new-password"
              }
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter")
                  document.getElementById("login")?.click();
              }}
              placeholder="至少 12 个字符"
            />
          </label>
          {error && (
            <div role="alert" className="banner error">
              {error}
            </div>
          )}
          <button
            id="login"
            className="primary full"
            disabled={busy || !auth}
            onClick={() =>
              act(async () => {
                const s = await api(
                  auth.initialized ? "/auth/session" : "/auth/bootstrap",
                  "POST",
                  auth.initialized ? { password } : { setupToken, password },
                );
                csrf = s.csrf;
                setSession(s);
                setPassword("");
                setSetupToken("");
                setAuth(await api("/auth/state"));
              })
            }
          >
            {busy
              ? "正在验证…"
              : auth?.initialized
                ? "登录管理中心"
                : "创建并进入"}
          </button>
          <div className="login-note">
            默认仅回环监听 · 凭据加密存储 · 无默认密码
          </div>
        </div>
      </div>
    );
  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <b>F</b>FlowHub
        </div>
        <div className="workspace-card">
          <span>◈</span>
          <div>
            <strong>本机工作空间</strong>
            <small>单用户 · Local workspace</small>
          </div>
        </div>
        <small className="nav-caption">WORKSPACE</small>
        <nav>
          {[
            ["workflows", "工作流库"],
            ["editor", "流程编排"],
            ["connections", "MCP 工具库"],
            ["bindings", "环境与权限"],
            ["runs", "运行记录"],
            ["settings", "接入设置"],
          ].map(([key, label]) => (
            <button
              aria-label={label}
              key={key}
              className={"nav-item " + (page === key ? "active" : "")}
              onClick={() =>
                key === "editor"
                  ? workflows[0] && chooseWorkflow(workflows[0])
                  : navigate("/" + key)
              }
            >
              <i>{glyph[key]}</i>
              {label}
              {key === "workflows" && <small>{workflows.length}</small>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="gateway">
            <strong>
              <span className="dot" /> Gateway MCP
            </strong>
            <p>1 个入口 · 固定 7 个工具</p>
            <div className="meter" />
          </div>
          <div className="profile">
            <span>AD</span>
            <div>
              <strong>本机管理员</strong>
              <small>独立管理会话</small>
            </div>
            <button
              aria-label="退出登录"
              onClick={() =>
                act(async () => {
                  await api("/auth/session", "DELETE");
                  setSession(null);
                })
              }
            >
              ↪
            </button>
          </div>
        </div>
      </aside>
      <main>
        <header className="topbar">
          <span>
            工作空间 <b>/</b>{" "}
            {
              (
                {
                  workflows: "工作流库",
                  editor: "流程编排",
                  connections: "MCP 工具库",
                  bindings: "环境与权限",
                  runs: "运行记录",
                  settings: "接入设置",
                } as J
              )[page]
            }
          </span>
          <div>
            <Badge tone="gray">LOCAL FIRST</Badge>
            <button
              onClick={() =>
                act(async () => {
                  await load();
                  setAuth(await api("/auth/state"));
                }, "状态已刷新")
              }
            >
              ↻ 刷新
            </button>
          </div>
        </header>
        <div className="workspace">
          {error && (
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
          {page === "workflows" && (
            <>
              <PageHead
                eyebrow="YOUR WORKFLOW LIBRARY"
                title="工作流"
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
                      environment: "staging",
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
                  ["运行记录", runs.length, "证据、版本与状态可追踪"],
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
                    <article className="workflow-card" key={w.id}>
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
                      <div className="card-actions">
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
                内置生产与试运行流程均为纯合成演示。真实绑定必须通过独立验证；环境不明时，请明确选择方案。
              </div>
            </>
          )}
          {page === "editor" && draft && (
            <>
              <PageHead
                eyebrow="WORKFLOW STUDIO"
                title={draft.draft.name}
                text="流程版本锁定工具、环境和资源。拖动位置不改变执行语义。"
              >
                <button onClick={() => showJson("工作流定义", draft.draft)}>
                  查看 DSL
                </button>
                <button
                  onClick={() =>
                    setModal({
                      type: "workflow-config",
                      title: "流程、输入契约与预算",
                      payload: {
                        ...draft.draft,
                        edges: edges.map((e) => ({
                          source: e.source,
                          target: e.target,
                          port: e.data?.port ?? "next",
                        })),
                      },
                    })
                  }
                >
                  流程配置
                </button>
                <button
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await save();
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
                <button disabled={busy} onClick={() => act(save, "草稿已保存")}>
                  保存草稿
                </button>
                <button
                  className="primary"
                  disabled={busy}
                  onClick={() =>
                    act(async () => {
                      await save();
                      await api(
                        "/workflows/" + draft.id + "/publish",
                        "POST",
                        {},
                      );
                      await load();
                      buildCanvas(
                        await api("/workflows/" + draft.id + "/draft"),
                      );
                    }, "不可变版本已发布")
                  }
                >
                  发布版本
                </button>
              </PageHead>
              <div className="editor-toolbar">
                <Badge tone="green">
                  ◇ {draft.draft.environment} · 固定绑定
                </Badge>
                <span>{dirty ? "● 有未保存修改" : "✓ 已从服务端加载"}</span>
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
              <div className="editor">
                <aside className="palette">
                  <h3>节点与工具</h3>
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
                  <JsonEditor
                    label="环境绑定引用"
                    value={draft.draft.bindings}
                    onChange={(v) => {
                      setDraft({
                        ...draft,
                        draft: { ...draft.draft, bindings: v },
                      });
                      setDirty(true);
                    }}
                  />
                </aside>
                <div className="canvas">
                  <ReactFlow
                    nodes={nodes}
                    edges={edges}
                    onNodesChange={(changes: NodeChange[]) => {
                      setNodes((n) => applyNodeChanges(changes, n));
                      if (
                        changes.some(
                          (c) => c.type === "position" || c.type === "remove",
                        )
                      )
                        setDirty(true);
                      for (const c of changes)
                        if (c.type === "remove") {
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
                      setEdges((old) => {
                        let next = old;
                        for (const c of changes)
                          if (c.type === "remove")
                            next = next.filter((e) => e.id !== c.id);
                        return next;
                      });
                      setDirty(true);
                    }}
                    onNodeClick={(_, n) => setSelected(n.id)}
                    onConnect={(c: Connection) => {
                      const source = draft.draft.nodes.find(
                          (n: J) => n.id === c.source,
                        ),
                        port =
                          source?.type === "condition"
                            ? (prompt("条件出口：true 或 false", "true") ??
                              "true")
                            : "next";
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
                    fitView
                    minZoom={0.2}
                    maxZoom={1.5}
                  >
                    <Background gap={22} size={1} />
                    <Controls />
                    <MiniMap pannable zoomable />
                  </ReactFlow>
                </div>
                <aside className="inspector">
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
                            固定环境绑定
                            <select
                              value={node.config.bindingKey}
                              onChange={(e) =>
                                changeNode({
                                  config: {
                                    ...node.config,
                                    bindingKey: e.target.value,
                                  },
                                })
                              }
                            >
                              {Object.keys(draft.draft.bindings).map((k) => (
                                <option key={k} value={k}>
                                  {k} · {draft.draft.bindings[k]}
                                </option>
                              ))}
                            </select>
                          </label>
                          <label className="field">
                            实际 MCP 工具
                            <select
                              value={node.config.toolName}
                              onChange={(e) => {
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
                            ◇ 环境与资源由发布绑定注入，Agent 无法覆盖。
                          </div>
                        </>
                      )}
                      {(node.type === "mcp_tool" ||
                        node.type === "agent_task") && (
                        <MappingFields
                          value={
                            node.config.argumentsMappings ??
                            node.config.inputMappings ??
                            {}
                          }
                          nodeIds={draft.draft.nodes
                            .filter((n: J) => n.id !== node.id)
                            .map((n: J) => n.id)}
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
                      <JsonEditor
                        label="节点配置（映射 / Schema）"
                        value={node.config}
                        onChange={(config) => changeNode({ config })}
                      />
                      {node.type === "mcp_tool" && (
                        <button
                          onClick={() =>
                            showJson(
                              "实际工具 Schema",
                              tools.find(
                                (t) => t.name === node.config.toolName,
                              ),
                            )
                          }
                        >
                          查看真实输入 / 输出 Schema
                        </button>
                      )}
                      <button
                        className="danger"
                        onClick={() => {
                          setNodes((x) => x.filter((n) => n.id !== selected));
                          setEdges((x) =>
                            x.filter(
                              (e) =>
                                e.source !== selected && e.target !== selected,
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
                </aside>
              </div>
            </>
          )}
          {page === "connections" && (
            <>
              <PageHead
                eyebrow="CONNECTED CAPABILITIES"
                title="MCP 工具库"
                text="登记独立连接，读取实际工具目录及 Schema 指纹。认证失败不会触发降级。"
              >
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
                        endpoint: "https://your-approved-host/mcp",
                        allowedHosts: ["your-approved-host"],
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
              </section>
            </>
          )}
          {page === "bindings" && (
            <>
              <PageHead
                eyebrow="ENVIRONMENT & POLICY"
                title="环境与权限"
                text="将环境、资源、凭证引用及查询模板固定为可验证的绑定档案。"
              >
                <button
                  className="primary"
                  onClick={() =>
                    setModal({
                      type: "binding",
                      title: "创建绑定档案",
                      payload: {
                        name: "新的只读绑定",
                        connectionId: connections[0]?.id,
                        environment: "staging",
                        allowedTools: [],
                        lockedArguments: { "/environment": "staging" },
                        allowedQueryTemplates: [],
                        maxRows: 100,
                        timeoutSeconds: 30,
                      },
                    })
                  }
                >
                  ＋ 新建档案
                </button>
              </PageHead>
              <div className="info">
                MOCK_VERIFIED 仅证明合成服务。真实 BINDING_VERIFIED
                需要获准的真实探测和独立的服务端只读权限确认。
              </div>
              <div className="binding-grid">
                {bindings.map((b) => (
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
                          setModal({
                            type: "edit-binding",
                            title: "修改绑定（需重新验证）",
                            id: b.id,
                            revision: b.revision,
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
                          })
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
                                arguments: {},
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
                            await api(
                              "/bindings/" + b.id,
                              "PATCH",
                              { revoked: true },
                              b.revision,
                            );
                            await load();
                          }, "绑定已撤销，旧运行也不能继续调用")
                        }
                      >
                        撤销
                      </button>
                    </div>
                  </section>
                ))}
              </div>
            </>
          )}
          {page === "runs" && !/^\/runs\/[^/]+$/.test(path) && (
            <>
              <PageHead
                eyebrow="EXECUTION HISTORY"
                title="运行记录"
                text="查看不可变运行快照、Agent 待办、人工审批及证据归档。"
              />
              <section className="panel">
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
                                : r.state.startsWith("WAITING")
                                  ? "amber"
                                  : "gray"
                            }
                          >
                            {statusLabels[r.state] ?? r.state}
                          </Badge>
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
                {!runs.length && (
                  <Empty text="暂无运行，从工作流库启动一次合成排查" />
                )}
              </section>
            </>
          )}
          {page === "runs" && /^\/runs\/[^/]+$/.test(path) && run && (
            <>
              <PageHead
                eyebrow="RUN DETAIL"
                title={run.workflowId}
                text={run.runId + " · v" + run.version}
              >
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
              <div className="run-summary">
                <Badge tone={run.state === "SUCCEEDED" ? "green" : "amber"}>
                  {statusLabels[run.state] ?? run.state}
                </Badge>
                <span>revision {run.revision}</span>
                <code>{run.snapshotHash.slice(0, 28)}…</code>
                {run.waitingReason && (
                  <span className="error">{run.waitingReason}</span>
                )}
              </div>
              <div className="run-grid">
                <section className="panel">
                  <h2>执行步骤</h2>
                  <div className="timeline">
                    {Object.entries(run.steps).map(([id, state]) => (
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
                        <Badge tone={state === "SUCCEEDED" ? "green" : "gray"}>
                          {String(state)}
                        </Badge>
                      </div>
                    ))}
                  </div>
                </section>
                <div>
                  {run.vaultLocked && (
                    <div className="banner">
                      凭据库已锁定，需管理员解锁后才能交付或推进检查点。
                      <button
                        onClick={() =>
                          setModal({
                            type: "unlock",
                            title: "解锁凭据库",
                            password: "",
                          })
                        }
                      >
                        解锁
                      </button>
                    </div>
                  )}
                  {run.approval && run.state === "WAITING_APPROVAL" && (
                    <section className="panel approval">
                      <Badge tone="amber">独立人工审批</Badge>
                      <h2>确认本次只读动作</h2>
                      <p>{run.approval.summary}</p>
                      <pre>{pretty(run.approval.arguments)}</pre>
                      <small>
                        审批绑定当前 snapshotHash 与
                        actionHash，过期或参数变化将被拒绝。
                      </small>
                      <div className="actions">
                        <button
                          className="danger"
                          onClick={() => approve("reject")}
                        >
                          拒绝并结束
                        </button>
                        <button
                          className="primary"
                          onClick={() => approve("approve")}
                        >
                          确认批准此动作
                        </button>
                      </div>
                    </section>
                  )}
                  {run.checkpoint && (
                    <section className="panel">
                      <Badge>WAITING_AGENT · {run.checkpoint.kind}</Badge>
                      <h2>{run.checkpoint.nodeId} · 宿主待办</h2>
                      <p>{run.checkpoint.instruction}</p>
                      <small>
                        由已连接的 Codex
                        提交结构化结果。下方可手动输入结果用于合成调试，不会替你调用模型。
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
                          disabled={!run.checkpoint.token}
                          onClick={() =>
                            setModal({
                              type: "agent",
                              title: "手动提交结构化结果",
                              payload: {},
                            })
                          }
                        >
                          手动提交
                        </button>
                        {run.checkpoint.kind === "host_skill" && (
                          <button
                            disabled={!run.checkpoint.token}
                            onClick={() =>
                              act(async () => {
                                const cp = run.checkpoint;
                                await api(
                                  "/runs/" + run.runId + "/advance",
                                  "POST",
                                  {
                                    runId: run.runId,
                                    checkpointId: cp.id,
                                    checkpointToken: cp.token,
                                    expectedRevision: run.revision,
                                    idempotencyKey: uid(),
                                    submission: {
                                      type: "host_skill_unavailable",
                                      useDeclaredFallback: true,
                                    },
                                  },
                                );
                                await refreshRun();
                              }, "已明确选择预声明模板，将记录未使用宿主 Skill")
                            }
                          >
                            Skill 不可用，使用已声明模板
                          </button>
                        )}
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
                          const reason = prompt(
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
                  <section className="panel">
                    <h2>
                      证据与报告 <small>{run.artifacts.length} 个</small>
                    </h2>
                    {run.artifacts.map((a: J) => (
                      <div className="artifact" key={a.id}>
                        <span>
                          {a.mimeType === "text/markdown" ? "▧" : "▤"}
                        </span>
                        <div>
                          <strong>
                            {a.nodeId} · {a.mimeType}
                          </strong>
                          <small>
                            {a.id} · {a.byteLength} bytes
                          </small>
                        </div>
                        <button
                          onClick={() =>
                            act(async () =>
                              setArtifact(
                                await api(
                                  "/runs/" +
                                    run.runId +
                                    "/artifacts/" +
                                    a.id +
                                    "?maxBytes=262144",
                                ),
                              ),
                            )
                          }
                        >
                          查看
                        </button>
                      </div>
                    ))}
                    {!run.artifacts.length && <Empty text="尚未收集到证据" />}
                    {artifact && (
                      <div className="evidence">
                        <div className="row">
                          <Badge tone="green">内容已存储 · SHA-256</Badge>
                          <button
                            onClick={() =>
                              download(
                                "evidence-" +
                                  artifact.artifactId +
                                  (artifact.mimeType === "text/markdown"
                                    ? ".md"
                                    : ".json"),
                                artifact.content,
                              )
                            }
                          >
                            下载当前块
                          </button>
                        </div>
                        <pre>{artifact.content}</pre>
                        {!artifact.eof && (
                          <button
                            onClick={() =>
                              act(async () => {
                                const next = await api(
                                  "/runs/" +
                                    run.runId +
                                    "/artifacts/" +
                                    artifact.artifactId +
                                    "?offset=" +
                                    artifact.nextOffset +
                                    "&maxBytes=262144",
                                );
                                setArtifact({
                                  ...next,
                                  content: artifact.content + next.content,
                                });
                              })
                            }
                          >
                            继续读取下一块
                          </button>
                        )}
                        <small>
                          格式和引用校验不代表事实已人工复核；Skill
                          执行仅为宿主声明。
                        </small>
                      </div>
                    )}
                  </section>
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
                title="接入设置"
                text="配置唯一 MCP 入口、独立管理权限与本机加密凭据库。"
              />
              <div className="settings-grid">
                <section className="panel">
                  <Badge tone="green">单入口 · 固定七工具</Badge>
                  <h2>接入 Codex</h2>
                  <p>
                    先启动 daemon，再让宿主启动 STDIO
                    薄桥。路径使用实际程序位置，参数以数组传递，不把 token 放入
                    URL 或参数。
                  </p>
                  <pre>
                    {pretty({
                      mcpServers: {
                        flowhub: {
                          command: "包内 runtime/node 或 node.exe",
                          args: [
                            "包内 dist/apps/daemon/src/cli.js",
                            "mcp",
                            "--stdio",
                            "--data-dir",
                            "本机批准数据目录",
                          ],
                        },
                      },
                    })}
                  </pre>
                  <div className="actions">
                    <button
                      onClick={() =>
                        setModal({
                          type: "client",
                          title: "创建独立宿主身份",
                          payload: {
                            label: "我的 Codex",
                            workflowAllowlist: workflows.map((w) => w.id),
                          },
                        })
                      }
                    >
                      创建受限宿主身份
                    </button>
                    <button
                      onClick={() =>
                        act(async () => {
                          const list = await api("/clients");
                          setModal({
                            type: "clients",
                            title: "宿主权限与撤销",
                            value: list,
                          });
                        })
                      }
                    >
                      管理宿主权限
                    </button>
                  </div>
                  <div className="info">
                    宿主分析收到的证据可能进入模型服务。真实数据是否可使用，需遵循组织授权；本机部署不保证数据不出网。
                  </div>
                </section>
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
                          value: await api("/retention/preview", "POST", {}),
                        }),
                      )
                    }
                  >
                    预览清理范围
                  </button>
                </section>
                <section className="panel">
                  <h2>加密凭据库</h2>
                  <p>scrypt 派生 · AES-256-GCM · 重启默认锁定</p>
                  <div className="actions">
                    <button
                      onClick={() =>
                        setModal({
                          type: "unlock",
                          title: "解锁凭据库",
                          password: "",
                        })
                      }
                    >
                      解锁
                    </button>
                    <button
                      onClick={() =>
                        act(async () => {
                          await api("/vault/lock", "POST", {});
                          setAuth({ ...auth, vaultLocked: true });
                        }, "凭据库已锁定")
                      }
                    >
                      立即锁定
                    </button>
                    <button
                      onClick={() =>
                        setModal({
                          type: "secret",
                          title: "新增凭据",
                          label: "新凭据",
                          value: "",
                        })
                      }
                    >
                      添加凭据
                    </button>
                    <button
                      onClick={() =>
                        setModal({
                          type: "rotate",
                          title: "修改凭据库口令",
                          payload: { oldPassword: "", newPassword: "" },
                        })
                      }
                    >
                      修改口令
                    </button>
                    <button
                      onClick={() =>
                        act(async () =>
                          showJson(
                            "凭据引用（不含明文）",
                            await api("/secrets"),
                          ),
                        )
                      }
                    >
                      查看引用
                    </button>
                  </div>
                  <p>
                    首次创建管理员时使用同一口令初始化凭据库。仅保存密文，不能找回丢失口令。
                  </p>
                </section>
                <section className="panel">
                  <h2>数据备份与支持包</h2>
                  <p>
                    程序与数据分离。备份包含敏感状态，只保存在本机；支持包仅导出白名单元数据。
                  </p>
                  <div className="actions">
                    <button
                      onClick={() =>
                        act(async () =>
                          showJson(
                            "一致性备份已保存",
                            await api("/backups", "POST", {}),
                          ),
                        )
                      }
                    >
                      SQLite 一致性备份
                    </button>
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
          <small>本机工作空间 / 独立管理员</small>
        </footer>
      </main>
      {modal && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setModal(null);
          }}
        >
          <section
            className={"modal " + (modal.type === "detail" ? "wide" : "")}
            role="dialog"
            aria-modal="true"
            aria-label={modal.title}
          >
            <div className="modal-head">
              <h2>{modal.title}</h2>
              <button aria-label="关闭" onClick={() => setModal(null)}>
                ×
              </button>
            </div>
            {modal.type === "versions" ? (
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
                      <small>{v.contentHash}</small>
                    </div>
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
            ) : modal.type === "rotate" ? (
              <>
                <Field
                  type="password"
                  label="当前凭据库口令"
                  value={modal.payload.oldPassword}
                  onChange={(oldPassword) =>
                    setModal({
                      ...modal,
                      payload: { ...modal.payload, oldPassword },
                    })
                  }
                />
                <Field
                  type="password"
                  label="新凭据库口令"
                  value={modal.payload.newPassword}
                  onChange={(newPassword) =>
                    setModal({
                      ...modal,
                      payload: { ...modal.payload, newPassword },
                    })
                  }
                />
              </>
            ) : modal.type === "retention" ? (
              <>
                <p>
                  原始结果到期后，日志、查询、分析及报告正文和相关审批参数、事件备注一并清理。
                  业务输入与运行元数据保留 30 天。活跃运行不受影响。
                </p>
                <ul>
                  <li>
                    原始结果与副本：{modal.value.resultRuns.length} 个运行
                  </li>
                  <li>遗留检查点：{modal.value.checkpoints.length} 个运行</li>
                  <li>运行元数据：{modal.value.runs.length} 个运行</li>
                  <li>产物：{modal.value.artifacts.length} 份</li>
                </ul>
                <details>
                  <summary>查看清理对象 ID</summary>
                  <pre>
                    {pretty({
                      原始结果运行: modal.value.resultRuns,
                      检查点运行: modal.value.checkpoints,
                      元数据运行: modal.value.runs,
                      产物: modal.value.artifacts,
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
            ) : modal.type === "new" ? (
              <>
                <Field
                  label="工作流名称"
                  value={modal.name}
                  onChange={(v) => setModal({ ...modal, name: v })}
                />
                <Field
                  label="工作流 ID"
                  value={modal.slug}
                  onChange={(v) => setModal({ ...modal, slug: v })}
                />
                <label className="field">
                  固定环境
                  <select
                    value={modal.environment}
                    onChange={(e) =>
                      setModal({ ...modal, environment: e.target.value })
                    }
                  >
                    <option value="staging">试运行（合成）</option>
                    <option value="production">生产（合成）</option>
                  </select>
                </label>
                <p>
                  从完整引导模板创建草稿。发布前仍需后端校验，不会复制真实凭据。
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
                <p>
                  输入严格按已发布 Schema 校验。不得覆盖环境、连接或模板；包含
                  Agent 的流程需要先解锁凭据库。
                </p>
                <details>
                  <summary>已发布输入契约</summary>
                  <pre>{pretty(startWorkflow.inputSchema)}</pre>
                </details>
                <JsonEditor
                  label="业务输入"
                  value={modal.payload}
                  onChange={(payload) => setModal({ ...modal, payload })}
                />
              </>
            ) : modal.type === "unlock" ? (
              <Field
                label="凭据库口令"
                type="password"
                value={modal.password}
                onChange={(password) => setModal({ ...modal, password })}
              />
            ) : modal.type === "secret" ? (
              <>
                <Field
                  label="凭据标签"
                  value={modal.label}
                  onChange={(label) => setModal({ ...modal, label })}
                />
                <Field
                  label="凭据值"
                  type="password"
                  value={modal.value}
                  onChange={(value) => setModal({ ...modal, value })}
                />
              </>
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
              <JsonEditor
                label={
                  modal.type === "agent" ? "检查点结构化输出" : "配置 JSON"
                }
                value={modal.payload}
                onChange={(payload) => setModal({ ...modal, payload })}
              />
            )}
            <div className="modal-actions">
              <button onClick={() => setModal(null)}>关闭</button>
              {!["detail", "support", "clients", "versions"].includes(
                modal.type,
              ) && (
                <button
                  className="primary"
                  disabled={
                    busy ||
                    (modal.type === "retention" &&
                      !["runs", "resultRuns", "checkpoints", "artifacts"].some(
                        (key) => modal.value[key].length,
                      ))
                  }
                  onClick={submitModal}
                >
                  {busy
                    ? "处理中…"
                    : modal.type === "retention"
                      ? "确认清理"
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
function download(filename: string, content: string) {
  const url = URL.createObjectURL(
    new Blob([content], { type: "text/plain;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
createRoot(document.getElementById("root")!).render(<App />);

function MappingFields({
  value,
  onChange,
  nodeIds,
}: {
  value: J;
  onChange: (v: J) => void;
  nodeIds: string[];
}) {
  const [error, setError] = useState("");
  const patch = (key: string, v: J) => onChange({ ...value, [key]: v });
  return (
    <section className="mapping-form">
      <h3>参数映射</h3>
      <small>目标字段 → 常量或已完成节点的 JSON Pointer</small>
      {Object.entries(value).map(([key, expr]: [string, J]) => (
        <div className="mapping-row" key={key}>
          <div className="row">
            <code>{key}</code>
            <button
              aria-label={"移除映射 " + key}
              onClick={() => {
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
            value={expr.ref?.source ?? "literal"}
            onChange={(e) =>
              patch(
                key,
                e.target.value === "literal"
                  ? { value: "" }
                  : {
                      ref: {
                        source: e.target.value,
                        pointer: "",
                        ...(e.target.value === "node"
                          ? { nodeId: nodeIds[0] }
                          : {}),
                      },
                    },
              )
            }
          >
            <option value="literal">固定常量</option>
            <option value="input">工作流输入</option>
            <option value="node">节点输出</option>
          </select>
          {expr.ref ? (
            <>
              {expr.ref.source === "node" && (
                <select
                  value={expr.ref.nodeId}
                  onChange={(e) =>
                    patch(key, { ref: { ...expr.ref, nodeId: e.target.value } })
                  }
                >
                  {nodeIds.map((id) => (
                    <option key={id}>{id}</option>
                  ))}
                </select>
              )}
              <input
                aria-label={key + " 引用路径"}
                placeholder="/orderNo"
                value={expr.ref.pointer}
                onChange={(e) =>
                  patch(key, { ref: { ...expr.ref, pointer: e.target.value } })
                }
              />
            </>
          ) : (
            <input
              aria-label={key + " 常量"}
              defaultValue={JSON.stringify(expr.value)}
              onBlur={(e) => {
                try {
                  patch(key, { value: JSON.parse(e.target.value) });
                  setError("");
                } catch {
                  setError(
                    '常量必须是合法 JSON 值，例如 \"order-by-number-v1\"',
                  );
                }
              }}
            />
          )}
        </div>
      ))}
      {error && <p className="error">{error}</p>}
      <button
        onClick={() => {
          const key = prompt("目标 JSON Pointer，例如 /parameters/orderNo");
          if (key) patch(key, { ref: { source: "input", pointer: "" } });
        }}
      >
        ＋ 添加参数映射
      </button>
    </section>
  );
}
