import { useEffect, useRef, useState } from "react";
import type { Api } from "../../shared/v2";
import { capabilityUsage } from "../discovery/capability-usage";
export const canAddCapability = (cap: any) =>
    !cap.stale &&
    cap.enabled === "enabled" &&
    ((cap.executor === "hub_direct" &&
      cap.kind === "mcp_tool" &&
      cap.availability === "ready") ||
      (cap.executor === "codex_host" &&
        cap.availability === "host_only" &&
        (cap.kind === "skill" ||
          (cap.kind === "mcp_tool" && cap.hasToolContract === true))));
export const directBindings = (cap: any, bindings: any[], environment: string) =>
    bindings.filter(
      (binding) =>
        binding.sourceCapabilityId === cap.id &&
        binding.environment === environment &&
        !binding.revoked &&
        binding.validationStatus !== "REVOKED" &&
        binding.sourceCapabilityRevision === cap.revision,
    );
async function ensureDirectBinding(api: Api, cap: any, environment: string, bindingId?: string) {
  const candidates = directBindings(cap, await api("/bindings"), environment);
  const binding = bindingId ? candidates.find(item => item.id === bindingId) : candidates.length === 1 ? candidates[0] : undefined;
  if (binding) return binding;
  if (bindingId) throw new Error("所选绑定已变化，请刷新后重新选择");
  if (candidates.length > 1) throw new Error("该工具有多个独立绑定，请选择对应的连接和身份");
  const result = await api(
    "/api/v2/capabilities/" + cap.id + "/import",
    "POST",
    {
      expectedSourceRevision: cap.revision,
      target: "hub_direct",
      environment,
      lockedArguments: {},
      idempotencyKey: crypto.randomUUID(),
    },
  );
  if (!result.bindingId)
    throw new Error("连接仍需配置：" + result.reason);
  return { id: result.bindingId };
}
export async function addCapabilityToDraft(api: Api, cap: any, draft: any, selected: string | null, bindingId?: string) {
  if (!canAddCapability(cap) || draft.draft.schemaVersion !== "flowhub.workflow/v2")
    throw new Error("请选择 v2 草稿和已同步契约的可用工具");
  const anchor =
      selected ?? draft.draft.nodes.find((n: any) => n.type === "input")?.id,
    edge = draft.draft.edges.find(
      (e: any) => e.source === anchor && e.port === "next",
    );
  if (!edge) throw new Error("请选择有下一步的串行节点作为插入位置");
  const nodeId = "tool-" + crypto.randomUUID().slice(0, 8),
    operations: any[] = [],
    capabilityRef = { capabilityId: cap.id, revision: cap.revision };
  if (cap.executor === "hub_direct") {
    const binding = await ensureDirectBinding(api, cap, draft.draft.environment, bindingId);
    const key = "role-" + crypto.randomUUID().slice(0, 8);
    operations.push(
      { op: "set_binding", key, bindingId: binding.id },
      {
        op: "add_node",
        nodeId,
        nodeType: "mcp_tool",
        title: cap.name,
        capabilityRef,
        config: { bindingKey: key, argumentsMappings: {} },
      },
    );
  } else {
    if (draft.draft.mode === "auto") operations.push({ op: "set_metadata", changes: { mode: "guided" } });
    const definition = await api(
      "/api/v2/capabilities/" +
        cap.id +
        "?includeSchemas=true&revision=" +
        cap.revision,
    );
    const skill = cap.kind === "skill";
    if (!skill && (!definition.inputSchema || !definition.outputSchema))
      throw new Error(
        "此宿主工具缺少输入或输出 Schema，可通过 Codex 任务说明使用。",
      );
    await api("/api/v2/capabilities/" + cap.id + "/import", "POST", {
      expectedSourceRevision: cap.revision,
      target: "codex_host",
      environment: draft.draft.environment,
      lockedArguments: {},
      idempotencyKey: crypto.randomUUID(),
    });
    const outputSchema = skill
      ? (definition.outputSchema ?? {
          type: "object",
          properties: {
            reportMarkdown: { type: "string" },
            evidenceRefs: { type: "array", items: { type: "string" } },
          },
          required: ["reportMarkdown", "evidenceRefs"],
          additionalProperties: false,
        })
      : definition.outputSchema;
    operations.push({
      op: "add_node",
      nodeId,
      nodeType: "agent_task",
      title: cap.name,
      capabilityRef,
      config: {
        kind: skill ? "host_skill" : "host_tool",
        ...(skill
          ? { skillRef: cap.name, reportContractRef: "incident-report/v1" }
          : { requireHostReceipt: true }),
        instructions:
          "在 Codex 宿主中执行 " +
          cap.name +
          "，按节点输出契约提交实际结果。",
        executorRef: "codex_host",
        inputMappings: {},
        outputSchema,
      },
    });
  }
  operations.push(
    {
      op: "disconnect",
      source: edge.source,
      target: edge.target,
      port: edge.port,
    },
    { op: "connect", source: anchor, target: nodeId, port: "next" },
    { op: "connect", source: nodeId, target: edge.target, port: "next" },
  );
  return patchDraft(api, draft, operations);
}

function patchDraft(api: Api, draft: any, operations: any[]) {
  return api("/api/v2/workflows/" + draft.id + "/operations", "POST", {
    expectedRevision: draft.revision, idempotencyKey: crypto.randomUUID(), operations,
  }, draft.revision);
}

function matchingExecutor(current: any, target: any) {
  if (!current || current.kind !== "mcp_tool" || target.kind !== "mcp_tool" ||
    current.executor === target.executor || current.contextId !== target.contextId || current.name !== target.name)
    return false;
  const host = current.executor === "codex_host" ? current : target;
  const direct = current.executor === "hub_direct" ? current : target;
  return !!host.provenance?.serverSourceId && host.provenance.serverSourceId === direct.sourceRefs?.[0]?.sourceId &&
    !!host.provenance.serverSourceFingerprint && host.provenance.serverSourceFingerprint === direct.provenance?.serverSourceFingerprint;
}

export function CapabilityPicker({
  api,
  draft,
  selected,
  knownBindings,
  dirty,
}: {
  api: Api;
  draft: any;
  selected: string | null;
  knownBindings: any[];
  dirty: boolean;
}) {
  const [caps, setCaps] = useState<any[]>([]),
    [query, setQuery] = useState(""),
    [executor, setExecutor] = useState("codex_host"),
    [contextId, setContextId] = useState(() => localStorage.getItem("flowhub.discovery.context") ?? ""),
    [contexts, setContexts] = useState<any[]>([]),
    [sourceId, setSourceId] = useState(""),
    [sources, setSources] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [selectedCapability, setSelectedCapability] = useState<any>(null),
    [bindingChoices, setBindingChoices] = useState<Record<string, string>>({});
  const request = useRef(0);
  const selectedNode = draft.draft.nodes.find((node: any) => node.id === selected);
  const selectedRef = selectedNode?.config.capabilityRef;
  useEffect(() => {
    setSelectedCapability(null);
    if (!selectedRef) return;
    let active = true;
    void api("/api/v2/capabilities/" + selectedRef.capabilityId + "?revision=" + selectedRef.revision)
      .then((value) => { if (active) setSelectedCapability(value); })
      .catch(() => {});
    return () => { active = false; };
  }, [selectedRef?.capabilityId, selectedRef?.revision]);
  const load = async (next?: string) => {
    const generation = ++request.current;
    const filters = new URLSearchParams({
      query,
      ...(contextId ? { contextId } : {}),
      ...(executor ? { executor } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(next ? { cursor: next } : {}),
    });
    const data = await api("/api/v2/capabilities?" + filters);
    if (generation !== request.current) return;
    setCaps((old) => (next ? [...old, ...data.items] : data.items));
    setCursor(data.nextCursor);
  };
  useEffect(() => {
    void api("/api/v2/host-contexts")
      .then(async (contexts: any[]) => {
        setContexts(contexts);
        setContextId((id) => contexts.some((context) => context.id === id) ? id : (contexts[0]?.id ?? ""));
        const all = await Promise.all(
          contexts
            .filter((c) => c.lastScanId)
            .map((c) => api("/api/v2/host-scans/" + c.lastScanId)),
        );
        setSources(all.flatMap((s) => s.sources ?? []));
      })
      .catch((e) => setError(e.message));
  }, []);
  useEffect(() => {
    setCaps([]);
    setCursor(null);
    void load().catch((e) => setError(e.message));
  }, [executor, contextId]);
  const add = async (cap: any, switching = false) => {
    setBusy(true);
    setError("");
    try {
      if (switching) {
        const operations = [];
        const bindingKey = cap.executor === "hub_direct" ? "role-" + crypto.randomUUID().slice(0, 8) : undefined;
        if (bindingKey) {
          const binding = await ensureDirectBinding(api, cap, draft.draft.environment, bindingChoices[cap.id]);
          operations.push({ op: "set_binding", key: bindingKey, bindingId: binding.id });
        }
        operations.push({ op: "switch_tool_executor", nodeId: selected, capabilityId: cap.id, revision: cap.revision, bindingKey });
        await patchDraft(api, draft, operations);
      } else await addCapabilityToDraft(api, cap, draft, selected, bindingChoices[cap.id]);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="v2-capability-picker">
      <h3>已发现能力</h3>
      <label className="field">
        查找工具
        <input value={query} onChange={(e) => setQuery(e.target.value)} />
      </label>
      <label className="field">
        调用位置
        <select value={executor} onChange={(e) => { setSourceId(""); setExecutor(e.target.value); }}>
          <option value="codex_host">由 Codex 执行</option>
          <option value="hub_direct">FlowHub 直连</option>
        </select>
      </label>
      {contexts.length > 1 && <label className="field">
        Codex 上下文
        <select value={contextId} onChange={(e) => { setSourceId(""); setContextId(e.target.value); }}>
          {contexts.map((context) => <option key={context.id} value={context.id}>
            {context.canonicalCwd} · {context.profile ?? "默认 Profile"}
          </option>)}
        </select>
      </label>}
      <label className="field">
        能力来源
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">全部来源</option>
          {sources.filter((s) => !contextId || s.contextId === contextId).map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} · {s.contextId} · r{s.revision}
            </option>
          ))}
        </select>
      </label>
      <button onClick={() => void load().catch((e) => setError(e.message))}>
        搜索能力
      </button>
      {error && <p role="alert">{error}</p>}
      {dirty && <p>保存画布上的修改后，可以添加工具或切换调用位置。</p>}
      {executor === "codex_host" && draft.draft.mode === "auto" && <p>添加宿主节点后，草稿将改为 Codex 接力模式。</p>}
      {!caps.length ? (
        <p>{executor === "codex_host" ? "请在 Codex 发现同步宿主工具目录。" : "独立运行时，请先启用并检测 FlowHub 直连。"}</p>
      ) : (
        caps.filter(c => c.executor === executor && (!contextId || c.contextId === contextId)).map((c) => {
          const bindings = c.executor === "hub_direct" ? directBindings(c, knownBindings, draft.draft.environment) : [];
          const disabled = busy || dirty || !canAddCapability(c) || (bindings.length > 1 && !bindingChoices[c.id]);
          return <div key={c.id}>
            {bindings.length > 1 && <label className="field">
              {c.name} 的直连绑定
              <select value={bindingChoices[c.id] ?? ""} onChange={(e) =>
                setBindingChoices(old => ({ ...old, [c.id]: e.target.value }))}>
                <option value="">选择连接和身份</option>
                {bindings.map(binding => <option key={binding.id} value={binding.id}>{binding.name} · {binding.connectionId}</option>)}
              </select>
            </label>}
            <button disabled={disabled} onClick={() => void add(c)}>
              {c.name}
              <small>{capabilityUsage(c)} · r{c.revision}</small>
              {c.executor === "hub_direct" && <small>{draft.draft.environment} · {
                bindings.length > 1 ? "请选择绑定" : bindings[0]?.name ?? "添加时登记绑定"
              }</small>}
            </button>
            {matchingExecutor(selectedCapability, c) && <button disabled={disabled} onClick={() => void add(c, true)}>
              将选中节点切换为{executor === "codex_host" ? " Codex 执行" : " FlowHub 直连"}
            </button>}
          </div>;
        })
      )}
      {cursor && (
        <button
          onClick={() => void load(cursor).catch((e) => setError(e.message))}
        >
          加载更多能力
        </button>
      )}
    </div>
  );
}
