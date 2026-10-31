import { useEffect, useRef, useState } from "react";
import { DiscoveryDrawer } from "./DiscoveryDrawer";
import {
  displayName,
  displaySummary,
  Icon,
  kinds,
  presentationLabels,
  Status,
  type Api,
  type Entity,
} from "./shared";

type Form = {
  displayName: string;
  summary: string;
  description: string;
  useCases: string;
  inputSummary: string;
  outputSummary: string;
};
const formFor = (e: Entity): Form => ({
  displayName: e.presentation.displayName ?? e.name,
  summary: e.presentation.summary ?? e.description ?? "",
  description: e.presentation.description ?? "",
  useCases: (e.presentation.useCases ?? []).join("\n"),
  inputSummary: e.presentation.inputSummary ?? "",
  outputSummary: e.presentation.outputSummary ?? "",
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
  const [environment, setEnvironment] = useState("test"),
    [lockedArguments, setLockedArguments] = useState("{}"),
    [credentials, setCredentials] = useState(false),
    [refs, setRefs] = useState<Record<string, string>>({}),
    [secrets, setSecrets] = useState<Entity[]>([]),
    [importInline, setImportInline] = useState(false);
  const generation = useRef(0);
  const v2 = (path: string, method = "GET", body?: any) =>
    api("/api/v2" + path, method, body);
  async function loadTools(e: Entity, next?: string) {
    const params = new URLSearchParams({
      contextId: e.contextId,
      kind: "mcp_tool",
      parentId: e.id,
      limit: "20",
      ...(next ? { cursor: next } : {}),
    });
    const token = generation.current,
      result = await v2("/discovery/catalog?" + params);
    if (generation.current !== token) return;
    setTools((previous) =>
      next ? [...previous, ...result.items] : result.items,
    );
    setCursor(result.nextCursor);
  }
  useEffect(() => {
    const token = ++generation.current;
    setEntity(null);
    setTools([]);
    setCursor(null);
    setError("");
    setNotice("");
    setTab("tools");
    setImportTarget(null);
    setCredentials(false);
    setEditing(!!drafts[id]);
    setWorking(false);
    void v2("/discovery/entities/" + encodeURIComponent(id))
      .then(async (value) => {
        if (token !== generation.current) return;
        setEntity(value);
        if (value.entityKind === "mcp_server") await loadTools(value);
      })
      .catch((e) => {
        if (token === generation.current) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [id, snapshot]);
  const form = drafts[id] ?? (entity ? formFor(entity) : null);
  const change = (key: keyof Form, value: string) => {
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
        contextId: entity!.contextId,
        expectedContextRevision: entity!.contextRevision,
        action: "submit_descriptions",
        idempotencyKey: crypto.randomUUID(),
        entries: [
          {
            entityId: entity!.id,
            entityKind: entity!.entityKind,
            expectedSourceRevision: entity!.revision,
            sourceFingerprint: entity!.sourceFingerprint,
            expectedPresentationRevision: entity!.presentation.revision,
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
            evidenceRefs: entity!.evidenceRefs.slice(0, 64),
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
  const importCapability = () =>
    run(async (current) => {
      const target = importTarget!;
      const result = await v2(
        "/capabilities/" + encodeURIComponent(target.capabilityId) + "/import",
        "POST",
        {
          expectedSourceRevision: target.capabilityRevision,
          target:
            target.executor === "hub_direct" ? "hub_direct" : "codex_host",
          environment,
          lockedArguments: JSON.parse(lockedArguments),
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (!current()) return;
      setImportTarget(null);
      setNotice(
        result.hostReference
          ? "Codex 宿主能力引用已登记。执行仍由 Codex 完成，可在编排画布中选择此技能。"
          : result.connectionId
            ? "连接与环境绑定已导入，资源绑定尚未验证。请前往 MCP 工具库和环境与权限完成验证。"
            : "仍需要连接配置：" + (result.missing ?? []).join("、"),
      );
    });
  const configure = () =>
    run(async (current) => {
      await v2(
        "/capability-sources/" + entity!.sourceId + "/credentials",
        "POST",
        {
          expectedRevision: entity!.configurationRevision,
          secretRefs: Object.fromEntries(
            Object.entries(refs).filter(([, value]) => value),
          ),
          importInlineCredentials: importInline,
          idempotencyKey: crypto.randomUUID(),
        },
      );
      if (!current()) return;
      setCredentials(false);
      setNotice("凭据引用已保存。请重新同步工具目录，之后再独立验证资源绑定。");
      await onChanged();
    });
  const beginCredentials = () =>
    run(async (current) => {
      const values = await api("/secrets");
      if (!current()) return;
      setSecrets(values);
      setRefs({});
      setImportInline(false);
      setCredentials(true);
    });
  const canImport = (e: Entity) =>
    !!e.capabilityId &&
    e.enabled &&
    !e.stale &&
    ["ready", "host_only"].includes(e.availability);
  const beginImport = (e: Entity) => {
    setImportTarget(e);
    setEnvironment("test");
    setLockedArguments("{}");
    setNotice("");
  };
  const footer = entity && (
    <>
      <span className="d-muted">
        {entity.entityKind === "skill"
          ? "执行原始技能；中文仅用于阅读。"
          : "工具目录读取成功不等于执行验证。"}
      </span>
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
        <button
          className="primary"
          disabled={working}
          onClick={() => void configure()}
        >
          保存连接引用
        </button>
      ) : importTarget ? (
        <button
          className="primary"
          disabled={working}
          onClick={() => void importCapability()}
        >
          {working
            ? "正在导入…"
            : importTarget.executor === "hub_direct"
              ? "导入连接与绑定"
              : "登记宿主能力引用"}
        </button>
      ) : canImport(entity) ? (
        <button className="primary" onClick={() => beginImport(entity)}>
          {entity.executor === "hub_direct"
            ? "导入到 FlowHub"
            : "用于 Codex 流程"}
          <Icon name="chevron" />
        </button>
      ) : entity.availability === "credentials_required" &&
        entity.executor === "hub_direct" ? (
        <button
          className="primary"
          disabled={working}
          onClick={() => void beginCredentials()}
        >
          配置连接凭据
        </button>
      ) : entity.entityKind === "mcp_server" &&
        !entity.self &&
        entity.enabled ? (
        <button
          className="primary"
          onClick={() => {
            close();
            onSync();
          }}
        >
          同步工具目录
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
                <a href="/connections">前往 MCP 工具库</a> ·{" "}
                <a href="/bindings">环境与权限</a>
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
                      value={form[key]}
                      maxLength={limit}
                      onChange={(e) => change(key, e.target.value)}
                    />
                  ) : (
                    <textarea
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
            <div className="d-edit-form">
              <h3>选择本地凭据引用</h3>
              <p>
                凭据由本地 Vault 加密保存；不会复制 Codex OAuth。Vault
                锁定时请先到接入设置解锁。
              </p>
              {(entity.credentialVariables ?? []).map((name: string) => (
                <label key={name}>
                  {name}
                  <select
                    value={refs[name] ?? ""}
                    onChange={(e) =>
                      setRefs({ ...refs, [name]: e.target.value })
                    }
                  >
                    <option value="">选择已有凭据</option>
                    {secrets.map((secret) => (
                      <option key={secret.id} value={secret.id}>
                        {secret.label} · {secret.id}
                      </option>
                    ))}
                  </select>
                </label>
              ))}
              <label className="d-check">
                <input
                  type="checkbox"
                  checked={importInline}
                  onChange={(e) => setImportInline(e.target.checked)}
                />
                将来源配置中已有的内联凭据存入本地 Vault
              </label>
              <a href="/settings">前往接入设置管理凭据</a>
              <button onClick={() => setCredentials(false)}>返回详情</button>
            </div>
          ) : importTarget ? (
            <div className="d-edit-form">
              <h3>导入：{displayName(importTarget, english)}</h3>
              <label>
                导入固定环境
                <select
                  aria-label="导入固定环境"
                  value={environment}
                  onChange={(e) => setEnvironment(e.target.value)}
                >
                  <option value="test">测试</option>
                  <option value="staging">试运行</option>
                  <option value="production">生产</option>
                </select>
              </label>
              <details>
                <summary>高级：锁定参数</summary>
                <label>
                  锁定参数 JSON
                  <textarea
                    value={lockedArguments}
                    onChange={(e) => setLockedArguments(e.target.value)}
                  />
                </label>
              </details>
              <p>导入保存连接和绑定，不执行工具。资源/环境绑定仍需独立验证。</p>
              <button onClick={() => setImportTarget(null)}>返回详情</button>
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
                  {entity.executor === "hub_direct"
                    ? "可导入 FlowHub"
                    : entity.executor === "codex_host"
                      ? "Codex 宿主"
                      : "说明与组件集合"}
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
                        tools.map((tool) => (
                          <article className="d-tool-card" key={tool.id}>
                            <strong>{displayName(tool, english)}</strong>
                            {tool.displayName !== tool.name && (
                              <span className="d-mono">{tool.name}</span>
                            )}
                            <p>{displaySummary(tool, english)}</p>
                            <div className="d-actions">
                              <button onClick={() => onNavigate(tool.id)}>
                                参数与结果
                              </button>
                              <button
                                disabled={!canImport(tool)}
                                onClick={() => beginImport(tool)}
                              >
                                {tool.executor === "hub_direct"
                                  ? "导入工具"
                                  : "用于 Codex 流程"}
                              </button>
                            </div>
                          </article>
                        ))
                      ) : (
                        <p>
                          {entity.toolCount === 0
                            ? "此服务的实际目录没有工具。"
                            : "工具目录尚不可用，请配置连接或同步目录。"}
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
                    <p>未读取到受支持的组件，数量保持未知。</p>
                  )}
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
