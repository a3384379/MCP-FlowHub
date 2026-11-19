import { capabilityUsage } from "./capability-usage";
import { useEffect, useRef, useState } from "react";
import { addCapabilityToDraft, canAddCapability, directBindings } from "../workflows/CapabilityPicker";
import { ConnectionSetup } from "./ConnectionSetup";
import { DiscoveryDrawer } from "./DiscoveryDrawer";
import {
  displayName,
  displaySummary,
  hostCatalogReason,
  Icon,
  kinds,
  presentationLabels,
  Status,
  type Api,
  type Entity,
} from "./shared";
import type { DiscoveryDestination } from "./issue-actions";

type Form = {
  displayName: string;
  summary: string;
  description: string;
  useCases: string;
  inputSummary: string;
  outputSummary: string;
  baseline: {
    contextId: string;
    expectedContextRevision: number;
    entityId: string;
    entityKind: string;
    expectedSourceRevision: number;
    sourceFingerprint: string;
    expectedPresentationRevision: number;
    evidenceRefs: string[];
  };
};
const formFor = (e: Entity): Form => ({
  displayName: e.presentation.displayName ?? e.name,
  summary: e.presentation.summary ?? e.description ?? "",
  description: e.presentation.description ?? "",
  useCases: (e.presentation.useCases ?? []).join("\n"),
  inputSummary: e.presentation.inputSummary ?? "",
  outputSummary: e.presentation.outputSummary ?? "",
  baseline: {
    contextId: e.contextId,
    expectedContextRevision: e.contextRevision,
    entityId: e.id,
    entityKind: e.entityKind,
    expectedSourceRevision: e.revision,
    sourceFingerprint: e.sourceFingerprint,
    expectedPresentationRevision: e.presentation.revision,
    evidenceRefs: e.evidenceRefs.slice(0, 64),
  },
});
export function DiscoveryDetail({
  id,
  api,
  english,
  close,
  onNavigate,
  onChanged,
  onSync,
  snapshot,
  drafts,
  setDraft,
  initialMode,
  onManage,
  onOpenWorkflow,
}: {
  id: string;
  api: Api;
  english: boolean;
  close: () => void;
  onNavigate: (id: string) => void;
  onChanged: () => Promise<void>;
  onSync: () => void;
  snapshot: string;
  drafts: Record<string, Form>;
  setDraft: (id: string, value: Form | null) => void;
  initialMode: "details" | "credentials";
  onManage: (destination: DiscoveryDestination) => void;
  onOpenWorkflow: (id: string) => void;
}) {
  const [entity, setEntity] = useState<Entity | null>(null),
    [tab, setTab] = useState("tools"),
    [tools, setTools] = useState<Entity[]>([]),
    [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [working, setWorking] = useState(false),
    [editing, setEditing] = useState(false),
    [importTarget, setImportTarget] = useState<Entity | null>(null);
  const [workflows, setWorkflows] = useState<Entity[]>([]),
    [workflow, setWorkflow] = useState<Entity | null>(null),
    [anchor, setAnchor] = useState(""),
    [bindingOptions, setBindingOptions] = useState<Entity[]>([]),
    [bindingId, setBindingId] = useState(""),
    [credentials, setCredentials] = useState(false),
    [secrets, setSecrets] = useState<Entity[]>([]),
    [credentialTarget, setCredentialTarget] = useState<{ sourceId: string; revision: number } | null>(null);
  const generation = useRef(0),
    readGeneration = useRef(0),
    credentialActivation = useRef(0),
    navigation = useRef(""),
    activateCredentials = useRef(false);
  const v2 = (path: string, method = "GET", body?: any) =>
    api("/api/v2" + path, method, body);
  async function activateCredentialForm(value: Entity, current: () => boolean) {
    const activation = ++credentialActivation.current,
      target = { sourceId: value.sourceId, revision: value.configurationRevision },
      ownsActivation = () => current() && activation === credentialActivation.current;
    try {
      const values = await api("/secrets");
      if (!ownsActivation()) return;
      setSecrets(values);
      setCredentialTarget(target);
      setNotice("");
      setEditing(false);
      setCredentials(true);
    } catch (e) {
      if (ownsActivation()) setError((e as Error).message);
    }
  }
  async function loadTools(e: Entity, next?: string) {
    const params = new URLSearchParams({
      contextId: e.contextId,
      kind: "mcp_tool",
      parentId: e.id,
      limit: "20",
      status: "all",
      ...(next ? { cursor: next } : {}),
    });
    const token = readGeneration.current,
      result = await v2("/discovery/catalog?" + params);
    if (readGeneration.current !== token) return;
    setTools((previous) =>
      next ? [...previous, ...result.items] : result.items,
    );
    setCursor(result.nextCursor);
  }
  useEffect(() => {
    return () => {
      generation.current++;
      readGeneration.current++;
      credentialActivation.current++;
      navigation.current = "";
    };
  }, []);
  useEffect(() => {
    const token = ++readGeneration.current,
      destination = JSON.stringify([id, initialMode]);
    if (navigation.current !== destination) {
      navigation.current = destination;
      generation.current++;
      credentialActivation.current++;
      activateCredentials.current = initialMode === "credentials";
      setEntity(null);
      setTools([]);
      setCursor(null);
      setError("");
      setNotice("");
      setTab("tools");
      setImportTarget(null);
      setCredentials(false);
      setCredentialTarget(null);
      setEditing(!!drafts[id]);
      setWorking(false);
    }
    const actionToken = generation.current;
    void v2("/discovery/entities/" + encodeURIComponent(id))
      .then(async (value) => {
        if (token !== readGeneration.current) return;
        setEntity(value);
        if (
          activateCredentials.current &&
          !value.stale &&
          value.connectionSetup === "references" &&
          value.executor === "hub_direct"
        ) {
          activateCredentials.current = false;
          await activateCredentialForm(value, () => actionToken === generation.current);
          if (actionToken !== generation.current) return;
        }
        if (value.entityKind === "mcp_server") await loadTools(value);
      })
      .catch((e) => {
        if (token === readGeneration.current) setError(e.message);
      });
    return () => {
      readGeneration.current++;
    };
  }, [id, snapshot, initialMode]);
  const form = drafts[id] ?? (entity ? formFor(entity) : null);
  const change = (key: Exclude<keyof Form, "baseline">, value: string) => {
    if (form) setDraft(id, { ...form, [key]: value });
  };
  const run = async (work: (current: () => boolean) => Promise<void>) => {
    const token = generation.current;
    setWorking(true);
    setError("");
    try {
      await work(() => generation.current === token);
    } catch (e) {
      if (generation.current === token) setError((e as Error).message);
    } finally {
      if (generation.current === token) setWorking(false);
    }
  };
  const save = () =>
    run(async (current) => {
      const value = await v2("/discovery/descriptions", "POST", {
        contextId: form!.baseline.contextId,
        expectedContextRevision: form!.baseline.expectedContextRevision,
        action: "submit_descriptions",
        idempotencyKey: crypto.randomUUID(),
        entries: [
          {
            entityId: form!.baseline.entityId,
            entityKind: form!.baseline.entityKind,
            expectedSourceRevision: form!.baseline.expectedSourceRevision,
            sourceFingerprint: form!.baseline.sourceFingerprint,
            expectedPresentationRevision: form!.baseline.expectedPresentationRevision,
            locale: "zh-CN",
            displayName: form!.displayName,
            summary: form!.summary,
            description: form!.description,
            useCases: form!.useCases
              .split("\n")
              .map((v) => v.trim())
              .filter(Boolean),
            inputSummary: form!.inputSummary,
            outputSummary: form!.outputSummary,
            evidenceRefs: form!.baseline.evidenceRefs,
          },
        ],
      });
      if (value.status !== "descriptions_saved")
        throw new Error("中文说明尚未保存。");
      if (!current()) return;
      setDraft(id, null);
      setEditing(false);
      setNotice("中文说明已保存，自动整理会保留你的手工修改。");
      const updated = await v2("/discovery/entities/" + encodeURIComponent(id));
      if (!current()) return;
      setEntity(updated);
      await onChanged();
    });
  const forPicker = (e: Entity) => ({
    ...e, id: e.capabilityId, revision: e.capabilityRevision,
    enabled: e.enabled ? "enabled" : "disabled", kind: e.entityKind,
  });
  const canImport = (e: Entity) => !!e.capabilityId && canAddCapability(forPicker(e));
  const beginCredentials = () =>
    run((current) => activateCredentialForm(entity!, current));
  const beginImport = (e: Entity) => run(async (current) => {
    const drafts = await api("/workflows");
    if (!current()) return;
    setNotice("");
    setWorkflows(drafts.filter((item: Entity) => item.draft.schemaVersion === "flowhub.workflow/v2"));
    setWorkflow(null);
    setAnchor("");
    setBindingOptions([]);
    setBindingId("");
    setImportTarget(e);
  });
  const chooseDraft = (id: string) => run(async (current) => {
    setWorkflow(null);
    setAnchor("");
    if (!id) return;
    const [draft, bindings, connections] = await Promise.all([
      v2("/workflows/" + encodeURIComponent(id) + "/draft"),
      importTarget?.executor === "hub_direct" ? api("/bindings") : Promise.resolve([]),
      importTarget?.executor === "hub_direct" ? api("/connections") : Promise.resolve([]),
    ]);
    if (!current()) return;
    setBindingOptions(importTarget?.executor === "hub_direct" ? directBindings(forPicker(importTarget), bindings, draft.draft.environment, connections) : []);
    setBindingId("");
    setWorkflow(draft);
    const input = draft.draft.nodes.find((node: Entity) => node.type === "input");
    if (draft.draft.edges.some((edge: Entity) => edge.source === input?.id && edge.port === "next"))
      setAnchor(input.id);
  });
  const importCapability = () => run(async (current) => {
    await addCapabilityToDraft(api, forPicker(importTarget!), workflow, anchor, bindingId || undefined);
    if (current()) onOpenWorkflow(workflow!.id);
  });
  const footer = entity && (
    <>
      <span className="d-muted">
        {entity.installation === "available_only" ? "此项尚未安装；请在 Codex 中安装后重新扫描。" : entity.entityKind === "skill"
          ? "执行原始技能；中文仅用于阅读。"
          : "工具目录读取成功不等于执行验证。"}
      </span>
      {!editing && !credentials && !importTarget && !entity.stale && !entity.self &&
        entity.entityKind === "mcp_server" && entity.enabled && entity.sourceId && (
          <button disabled={working} onClick={() => {
            if (entity.executor === "hub_direct" && entity.connectionSetup === "references") void beginCredentials();
            else onManage({ type: "connection", name: entity.name });
          }}>{entity.preparedConnectionId ? "管理 FlowHub 直连" : "启用 FlowHub 直连"}</button>
        )}
      {editing ? (
        <div className="d-actions">
          <button
            disabled={working}
            onClick={() => {
              setEditing(false);
              setDraft(id, null);
            }}
          >
            取消编辑
          </button>
          <button
            className="primary"
            disabled={working || !form?.displayName.trim()}
            onClick={() => void save()}
          >
            {working ? "正在保存…" : "保存中文说明"}
          </button>
        </div>
      ) : credentials ? (
        <div className="d-actions">
          <button disabled={working} type="submit" form={"connection-setup-" + entity.id} name="action" value="save">保存配置</button>
          <button className="primary" disabled={working} type="submit" form={"connection-setup-" + entity.id} name="action" value="detect">{working ? "处理中…" : "保存并检测连接"}</button>
        </div>
      ) : importTarget ? (
        <button className="primary" disabled={working || !workflow || !anchor || (bindingOptions.length > 1 && !bindingId)} onClick={() => void importCapability()}>
          {working ? "正在处理…" : "添加并打开编排"}
        </button>
      ) : canImport(entity) ? (
        <button className="primary" disabled={working} onClick={() => void beginImport(entity)}>
          {entity.executor === "hub_direct" ? "用直连添加到流程" : "用 Codex 添加到流程"}
          <Icon name="chevron" />
        </button>
      ) : entity.entityKind === "mcp_server" && !entity.self && entity.enabled && !entity.hostCatalogReady ? (
        <button className="primary" onClick={() => { close(); onSync(); }}>
          同步 Codex 工具目录
        </button>
      ) : (
        <button onClick={close}>关闭详情</button>
      )}
    </>
  );
  return (
    <DiscoveryDrawer
      label={(entity ? kinds[entity.entityKind] : "能力") + " / 详情"}
      close={close}
      footer={footer}
    >
      {!entity && (
        <>
          <h2 id="d-drawer-title">正在读取能力详情</h2>
          {!error && <p>读取真实来源与说明…</p>}
        </>
      )}
      {entity && (
        <>
          <div className="d-detail-title">
            <span className={"d-cap-icon " + entity.entityKind}>
              <Icon name={entity.entityKind} />
            </span>
            <div>
              <h2 id="d-drawer-title">{displayName(entity, english)}</h2>
              <span className="d-mono">{entity.name}</span>
            </div>
          </div>
          <p className="d-detail-intro">{displaySummary(entity, english)}</p>
          <div className="d-detail-status">
            <Status entity={entity} />
            <span className="d-tag">{kinds[entity.entityKind]}</span>
            <span className="d-tag gray">
              {presentationLabels[entity.presentation.state]}
            </span>
          </div>
          {notice && (
            <div className="d-notice" role="status">
              {notice}
              <div>
                <a href="/connections">前往 MCP 服务</a> ·{" "}
                <a href="/bindings">环境与资源</a>
              </div>
            </div>
          )}
          {entity.stale && (
            <div className="d-notice">
              来源已更新或未在当前扫描中确认。请重新扫描后再导入；已保存的中文说明仍保留。
            </div>
          )}
          {editing && form ? (
            <div className="d-edit-form">
              <p>
                仅修改阅读说明，原始名称、技能内容与 Schema 保持原值。Esc
                收起后重新打开可继续编辑。
              </p>
              {(form.baseline.expectedSourceRevision !== entity.revision ||
                form.baseline.sourceFingerprint !== entity.sourceFingerprint ||
                form.baseline.expectedContextRevision !== entity.contextRevision ||
                form.baseline.expectedPresentationRevision !== entity.presentation.revision) && (
                <p className="d-notice" role="status">
                  来源或中文说明已更新。当前草稿保留开始编辑时的版本，保存时会校验冲突。请保留草稿并重新核对；取消编辑后可从最新版本重新开始。
                </p>
              )}
              {(
                [
                  ["displayName", "中文显示名称", 120],
                  ["summary", "一句话用途", 500],
                  ["description", "详细介绍", 8000],
                  ["useCases", "使用场景（每行一项）", 10000],
                  ["inputSummary", "输入说明", 1000],
                  ["outputSummary", "输出说明", 1000],
                ] as const
              ).map(([key, label, limit]) => (
                <label key={key}>
                  {label}
                  {key === "displayName" ? (
                    <input
                      aria-label={label}
                      disabled={working}
                      value={form[key]}
                      maxLength={limit}
                      onChange={(e) => change(key, e.target.value)}
                    />
                  ) : (
                    <textarea
                      aria-label={label}
                      disabled={working}
                      rows={key === "description" ? 5 : 2}
                      value={form[key]}
                      maxLength={limit}
                      onChange={(e) => change(key, e.target.value)}
                    />
                  )}
                </label>
              ))}
            </div>
          ) : credentials ? (
            <ConnectionSetup key={entity.id + ":" + credentialTarget?.revision} api={api} entity={entity} initialSecrets={secrets}
              formId={"connection-setup-" + entity.id} onBusy={setWorking} onChanged={onChanged}
              onManage={() => onManage({ type: "library" })} />
          ) : importTarget ? (
            <div className="d-edit-form">
              <h3>添加到流程</h3>
              <p>{displayName(importTarget, english)} · {importTarget.executor === "hub_direct" ? "FlowHub 直连" : "由 Codex 执行"}</p>
              {workflows.length ? (
                <>
                  <label>工作流草稿
                    <select disabled={working} value={workflow?.id ?? ""} onChange={(e) => void chooseDraft(e.target.value)}>
                      <option value="">选择草稿</option>
                      {workflows.map((item) => <option key={item.id} value={item.id}>{item.draft.name} · {item.draft.environment}</option>)}
                    </select>
                  </label>
                  {workflow && <label>插入位置
                    <select disabled={working} value={anchor} onChange={(e) => setAnchor(e.target.value)}>
                      <option value="">选择有下一步的串行节点</option>
                      {workflow.draft.nodes.filter((node: Entity) => workflow.draft.edges.some(
                        (edge: Entity) => edge.source === node.id && edge.port === "next",
                      )).map((node: Entity) => <option key={node.id} value={node.id}>{node.title}之后</option>)}
                    </select>
                  </label>}
                  {bindingOptions.length > 1 && <label>直连绑定
                    <select disabled={working} value={bindingId} onChange={(e) => setBindingId(e.target.value)}>
                      <option value="">选择连接和身份</option>
                      {bindingOptions.map(binding => <option key={binding.id} value={binding.id}>{binding.name} · {binding.connectionId}</option>)}
                    </select>
                  </label>}
                </>
              ) : <p>请先在工作流库新建一个 v2 草稿。</p>}
              <button disabled={working} onClick={() => setImportTarget(null)}>返回详情</button>
            </div>
          ) : (
            <>
              <div className="d-fact-grid">
                <div>
                  <small>所属来源</small>
                  {entity.plugin ? (
                    <button
                      className="d-link"
                      onClick={() => onNavigate(entity.plugin.id)}
                    >
                      {displayName(entity.plugin, english)}
                    </button>
                  ) : entity.entityKind === "skill" ? (
                    "独立 Skill"
                  ) : (
                    "独立来源"
                  )}
                </div>
                <div>
                  <small>使用位置</small>
                  {entity.entityKind !== "mcp_server"
                    ? capabilityUsage({ ...entity, kind: entity.entityKind })
                    : entity.hostCatalogReady
                      ? "由 Codex 执行 · 目录已同步"
                      : hostCatalogReason(entity) || (entity.hostCatalogStatus === "ready"
                        ? "Codex 目录已同步"
                        : "Codex 工具目录待同步")}
                </div>
                <div>
                  <small>
                    {entity.entityKind === "skill" ? "MCP 依赖" : "工具目录"}
                  </small>
                  {entity.entityKind === "skill"
                    ? entity.relations?.filter(
                        (r: any) => r.kind === "dependency",
                      ).length + " 项已声明"
                    : entity.toolCount == null
                      ? "以实际目录为准"
                      : entity.toolCount + " 个工具"}
                </div>
                <div>
                  <small>说明状态</small>
                  {presentationLabels[entity.presentation.state]}
                </div>
              </div>
              {entity.entityKind === "mcp_server" && (
                <>
                  <div className="d-detail-tabs">
                    {[
                      ["tools", "工具目录"],
                      ["related", "相关 Skills"],
                      ["source", "来源信息"],
                    ].map(([value, label]) => (
                      <button
                        className={tab === value ? "active" : ""}
                        onClick={() => setTab(value)}
                        key={value}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  {tab === "tools" && (
                    <div className="d-detail-section">
                      <h3>
                        可提供的工具
                        {entity.toolCount != null && (
                          <small>{entity.toolCount} 项</small>
                        )}
                      </h3>
                      {tools.length ? (
                        [...tools].sort((a, b) => Number(a.stale) - Number(b.stale) ||
                          Number(b.executor === "codex_host") - Number(a.executor === "codex_host")).map((tool) => (
                          <article className="d-tool-card" key={tool.id}>
                            <strong>{displayName(tool, english)}</strong>
                            {tool.displayName !== tool.name && (
                              <span className="d-mono">{tool.name}</span>
                            )}
                            <p>{displaySummary(tool, english)}</p>
                            <small>{tool.stale ? hostCatalogReason(tool) || "保留的旧目录" : capabilityUsage({ ...tool, kind: "mcp_tool" })}</small>
                            <div className="d-actions">
                              <button onClick={() => onNavigate(tool.id)}>
                                参数与结果
                              </button>
                              <button
                                disabled={working || !canImport(tool)}
                                onClick={() => void beginImport(tool)}
                              >
                                {tool.executor === "hub_direct"
                                  ? "用直连添加到流程"
                                  : "用 Codex 添加到流程"}
                              </button>
                            </div>
                          </article>
                        ))
                      ) : (
                        <p>
                          {entity.toolCount === 0
                            ? "此服务的实际目录没有工具。"
                            : hostCatalogReason(entity) || "请同步 Codex 工具目录。"}
                        </p>
                      )}
                      {cursor && (
                        <button
                          disabled={working}
                          onClick={() =>
                            void run(() => loadTools(entity, cursor))
                          }
                        >
                          加载更多工具
                        </button>
                      )}
                    </div>
                  )}
                  {tab === "related" && (
                    <div className="d-detail-section">
                      <h3>与此服务有关的 Skills</h3>
                      {entity.relatedSkills.length ? (
                        entity.relatedSkills.map((skill: Entity) => (
                          <div className="d-relation" key={skill.id}>
                            <Icon name="skill" />
                            <button
                              className="d-link"
                              onClick={() => onNavigate(skill.id)}
                            >
                              {displayName(skill, english)}
                            </button>
                            <span className="d-tag purple">
                              {
                                {
                                  dependency: "声明依赖",
                                  mention: "说明中提及",
                                  same_plugin: "同一插件",
                                }[skill.relationKind as string]
                              }
                            </span>
                          </div>
                        ))
                      ) : (
                        <p>当前没有确认的相关 Skill。</p>
                      )}
                      <p>
                        同一插件表示打包关系；声明依赖表示使用关系，二者分别展示。
                      </p>
                    </div>
                  )}
                </>
              )}
              {entity.entityKind === "skill" && (
                <>
                  <div className="d-detail-section">
                    <h3>什么时候使用</h3>
                    {entity.presentation.useCases?.length &&
                    entity.presentation.state !== "stale" ? (
                      <ul>
                        {entity.presentation.useCases.map(
                          (value: string, index: number) => (
                            <li key={index}>{value}</li>
                          ),
                        )}
                      </ul>
                    ) : (
                      <p>{displaySummary(entity, english)}</p>
                    )}
                  </div>
                  <div className="d-detail-section">
                    <h3>需要提供什么 / 得到什么</h3>
                    <p>
                      输入：
                      {(entity.presentation.state !== "stale" &&
                        entity.presentation.inputSummary) ||
                        "来源尚未提供独立的输入说明，请查看原始技能内容。"}
                    </p>
                    <p>
                      输出：
                      {(entity.presentation.state !== "stale" &&
                        entity.presentation.outputSummary) ||
                        "来源尚未提供独立的输出说明。"}
                    </p>
                  </div>
                  <div className="d-detail-section">
                    <h3>关联 MCP</h3>
                    {entity.relations?.length ? (
                      entity.relations.map((r: any, i: number) => (
                        <div className="d-dependency" key={i}>
                          <div>
                            {r.targetId ? (
                              <button
                                className="d-link"
                                onClick={() => onNavigate(r.targetId)}
                              >
                                {r.name}
                              </button>
                            ) : (
                              <strong>{r.name}</strong>
                            )}
                            <span className="d-tag">
                              {r.kind === "mention"
                                ? "说明中提及"
                                : (
                                    {
                                      matched: "声明依赖 · 已匹配",
                                      missing: "声明依赖 · 未发现",
                                      ambiguous: "声明依赖 · 多个同名来源",
                                      disabled: "声明依赖 · 已停用",
                                    } as Record<string, string>
                                  )[r.status]}
                            </span>
                          </div>
                          <small>依据：{r.evidence}</small>
                        </div>
                      ))
                    ) : (
                      <p>
                        当前未声明 MCP 依赖。独立 Skill 无须强制归属于某个 MCP。
                      </p>
                    )}
                  </div>
                </>
              )}
              {entity.entityKind === "mcp_tool" && (
                <div className="d-detail-section">
                  <h3>参数与结果</h3>
                  {["inputSchema", "outputSchema"].map((key) => (
                    <div className="d-tool-card" key={key}>
                      <strong>
                        {key === "inputSchema" ? "输入参数" : "返回结果"}
                      </strong>
                      {entity.capability?.[key]?.properties ? (
                        Object.entries(entity.capability[key].properties).map(
                          ([name, property]: [string, any]) => {
                            const pointer =
                              "/" +
                              key +
                              "/properties/" +
                              name.replace(/~/g, "~0").replace(/\//g, "~1");
                            const translated =
                              entity.presentation.state !== "stale" &&
                              entity.presentation.parameterDescriptions?.find(
                                (p: any) => p.pointer === pointer,
                              )?.description;
                            return (
                              <p key={name}>
                                <code>{name}</code> ·{" "}
                                {property.type ?? "以 Schema 为准"} ·{" "}
                                {translated ||
                                  property.description ||
                                  "来源未提供说明"}
                              </p>
                            );
                          },
                        )
                      ) : (
                        <p>来源未提供独立字段说明，可查看原始 Schema。</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
              {entity.entityKind === "plugin" && (
                <div className="d-detail-section">
                  <h3>插件包含的组件</h3>
                  {entity.children.map((child: Entity) => (
                    <div className="d-relation" key={child.id}>
                      <Icon name={child.entityKind} />
                      <button
                        className="d-link"
                        onClick={() => onNavigate(child.id)}
                      >
                        {displayName(child, english)}
                      </button>
                      <span className="d-tag">{kinds[child.entityKind]}</span>
                    </div>
                  ))}
                  {!entity.children.length && (
                    <p>{entity.installation === "available_only" ? "仅有市场介绍，尚未安装或读取插件组件。" : "未读取到受支持的组件，数量保持未知。"}</p>
                  )}
                </div>
              )}
              {entity.entityKind === "plugin" && entity.marketplaceSources?.length > 0 && (
                <div className="d-detail-section">
                  <h3>市场来源{entity.marketplaceConflict ? "差异" : "记录"}</h3>
                  {entity.marketplaceConflict && <p role="status">不同来源的市场资料存在冲突，尚未判定覆盖关系。安装状态仍依据实际安装清单。</p>}
                  {entity.marketplaceSources.map((source: Entity) => (
                    <div className="d-source-box" key={source.path}>
                      <p>来源：<code>{source.path}</code></p>
                      <p>介绍：{source.description || "来源未提供介绍"}</p>
                      <p>类别：{source.category} · 安装策略：{source.marketplacePolicy} · 认证时机：{source.authenticationPolicy}</p>
                    </div>
                  ))}
                </div>
              )}
              {(entity.entityKind !== "mcp_server" || tab === "source") && (
                <div className="d-detail-section">
                  <h3>来源与中文说明</h3>
                  <div className="d-source-box">
                    来源：{entity.plugin?.name || "独立来源"}
                    <br />
                    中文说明：{presentationLabels[entity.presentation.state]}
                    <br />
                    原始名称：<code>{entity.name}</code>
                    <br />
                    {entity.path && (
                      <>
                        位置：{entity.path}
                        <br />
                      </>
                    )}
                    来源修订：r{entity.revision}
                  </div>
                  {entity.presentation.state !== "stale" &&
                    entity.presentation.description && (
                      <p className="d-long-description">
                        {entity.presentation.description}
                      </p>
                    )}
                  {entity.presentation.state === "stale" &&
                    entity.presentation.displayName && (
                      <details>
                        <summary>查看保留的旧中文说明</summary>
                        <p>
                          {entity.presentation.displayName} ·{" "}
                          {entity.presentation.summary}
                        </p>
                      </details>
                    )}
                </div>
              )}
              <div className="d-detail-section">
                <button
                  className="d-link"
                  disabled={entity.stale}
                  onClick={() => {
                    setEditing(true);
                    setDraft(id, formFor(entity));
                  }}
                >
                  编辑中文说明
                </button>
              </div>
              <details className="d-technical">
                <summary>原始说明与技术信息</summary>
                <p>{entity.description || "来源未提供原始介绍。"}</p>
                {entity.capability?.skillContent && (
                  <>
                    <h4>原始技能说明</h4>
                    <pre>{entity.capability.skillContent}</pre>
                    {entity.capability.contentTruncated && (
                      <p>原始内容超过读取上限，当前展示前 32768 字符。</p>
                    )}
                  </>
                )}
                <pre>
                  {JSON.stringify(
                    entity.capability
                      ? {
                          id: entity.capability.id,
                          name: entity.capability.name,
                          inputSchema: entity.capability.inputSchema,
                          outputSchema: entity.capability.outputSchema,
                          sourceRefs: entity.capability.sourceRefs,
                          revision: entity.capability.revision,
                        }
                      : {
                          id: entity.id,
                          sourceKey: entity.sourceKey,
                          sourceChain: entity.sourceChain,
                          path: entity.path,
                          revision: entity.revision,
                          sourceFingerprint: entity.sourceFingerprint,
                          executor: entity.executor,
                        },
                    null,
                    2,
                  )}
                </pre>
              </details>
            </>
          )}
        </>
      )}
      {error && (
        <div className="d-error" role="alert">
          {error}
        </div>
      )}
    </DiscoveryDrawer>
  );
}
