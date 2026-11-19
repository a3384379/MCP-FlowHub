import { useEffect, useState } from "react";
import type { Api } from "../../shared/v2";
import { capabilityUsage } from "../discovery/capability-usage";
export function CapabilityPicker({
  api,
  draft,
  selected,
  knownBindings,
}: {
  api: Api;
  draft: any;
  selected: string | null;
  knownBindings: any[];
}) {
  const [caps, setCaps] = useState<any[]>([]),
    [query, setQuery] = useState(""),
    [executor, setExecutor] = useState(""),
    [sourceId, setSourceId] = useState(""),
    [sources, setSources] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const load = async (next?: string) => {
    const filters = new URLSearchParams({
      query,
      ...(executor ? { executor } : {}),
      ...(sourceId ? { sourceId } : {}),
      ...(next ? { cursor: next } : {}),
    });
    const data = await api("/api/v2/capabilities?" + filters);
    setCaps((old) => (next ? [...old, ...data.items] : data.items));
    setCursor(data.nextCursor);
  };
  useEffect(() => {
    void load().catch((e) => setError(e.message));
    void api("/api/v2/host-contexts")
      .then(async (contexts: any[]) => {
        const all = await Promise.all(
          contexts
            .filter((c) => c.lastScanId)
            .map((c) => api("/api/v2/host-scans/" + c.lastScanId)),
        );
        setSources(all.flatMap((s) => s.sources ?? []));
      })
      .catch((e) => setError(e.message));
  }, []);
  const canAdd = (cap: any) =>
    !cap.stale &&
    cap.enabled === "enabled" &&
    ((cap.executor === "hub_direct" &&
      cap.kind === "mcp_tool" &&
      cap.availability === "ready") ||
      (cap.executor === "codex_host" &&
        cap.availability === "host_only" &&
        (cap.kind === "skill" ||
          (cap.kind === "mcp_tool" && cap.hasToolContract === true))));
  const directBinding = (cap: any, bindings: any[]) =>
    bindings.find(
      (binding) =>
        binding.sourceCapabilityId === cap.id &&
        binding.environment === draft.draft.environment &&
        !binding.revoked &&
        binding.validationStatus !== "REVOKED" &&
        binding.sourceCapabilityRevision === cap.revision,
    );
  const add = async (cap: any) => {
    setBusy(true);
    setError("");
    try {
      const anchor =
          selected ?? draft.draft.nodes.find((n: any) => n.type === "input").id,
        edge = draft.draft.edges.find(
          (e: any) => e.source === anchor && e.port === "next",
        );
      if (!edge) throw new Error("请选择有下一步的串行节点作为插入位置");
      const nodeId = "tool-" + crypto.randomUUID().slice(0, 8),
        operations: any[] = [],
        capabilityRef = { capabilityId: cap.id, revision: cap.revision };
      if (cap.executor === "hub_direct") {
        const bindings = await api("/bindings");
        let binding = directBinding(cap, bindings);
        if (!binding) {
          const result = await api(
            "/api/v2/capabilities/" + cap.id + "/import",
            "POST",
            {
              expectedSourceRevision: cap.revision,
              target: "hub_direct",
              environment: draft.draft.environment,
              lockedArguments: {},
              idempotencyKey: crypto.randomUUID(),
            },
          );
          if (!result.bindingId)
            throw new Error("连接仍需配置：" + result.reason);
          binding = { id: result.bindingId };
        }
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
              : {}),
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
      await api(
        "/api/v2/workflows/" + draft.id + "/operations",
        "POST",
        {
          expectedRevision: draft.revision,
          idempotencyKey: crypto.randomUUID(),
          operations,
        },
        draft.revision,
      );
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
        <select value={executor} onChange={(e) => setExecutor(e.target.value)}>
          <option value="">全部</option>
          <option value="hub_direct">FlowHub</option>
          <option value="codex_host">Codex 宿主</option>
        </select>
      </label>
      <label className="field">
        能力来源
        <select value={sourceId} onChange={(e) => setSourceId(e.target.value)}>
          <option value="">全部来源</option>
          {sources.map((s) => (
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
      {!caps.length ? (
        <p>先到 能力发现同步目录。</p>
      ) : (
        caps.map((c) => (
          <button
            disabled={busy || !canAdd(c)}
            key={c.id}
            onClick={() => void add(c)}
          >
            {c.name}
            <small>
              {capabilityUsage(c)} · r{c.revision}
            </small>
            {c.executor === "hub_direct" && (
              <small>
                {draft.draft.environment} ·{" "}
                {directBinding(c, knownBindings)?.name ?? "添加时登记绑定"}
              </small>
            )}
          </button>
        ))
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
