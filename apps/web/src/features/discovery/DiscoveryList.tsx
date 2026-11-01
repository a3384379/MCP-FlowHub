import { useEffect, useState } from "react";
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

export function DiscoveryList({
  items,
  english,
  onDetail,
}: {
  items: Entity[];
  english: boolean;
  onDetail: (id: string) => void;
}) {
  return (
    <>
      <div className="d-list-head">
        <span>名称 / 用途</span>
        <span>来源</span>
        <span>状态 / 使用方式</span>
        <span>工具</span>
        <span />
      </div>
      {items.map((entity) => (
        <article className="d-cap-row" key={entity.id} data-entity-id={entity.id} data-entity-kind={entity.entityKind}>
          <div className="d-cap-main">
            <span className={"d-cap-icon " + entity.entityKind}>
              <Icon name={entity.entityKind} />
            </span>
            <div>
              <div className="d-cap-name">
                <strong>{displayName(entity, english)}</strong>
                {!english && entity.displayName !== entity.name && (
                  <span className="d-mono">{entity.name}</span>
                )}
              </div>
              <p>{displaySummary(entity, english)}</p>
            </div>
          </div>
          <div className="d-source">
            {(english ? entity.pluginName : entity.pluginDisplayName) ||
              (entity.entityKind === "skill"
                ? "独立 Skill"
                : entity.executor === "codex_host" && !entity.sourceId
                  ? "Codex 宿主目录"
                  : "独立 MCP 配置")}
            <small>
              {entity.pluginId
                ? "插件清单归属"
                : entity.entityKind === "skill"
                  ? "未归属于插件"
                  : "保留独立来源身份"}
            </small>
          </div>
          <div className="d-state">
            <Status entity={entity} />
            {entity.entityKind === "skill" && (
              <small>
                {entity.relations?.filter((r: any) => r.kind === "dependency")
                  .length
                  ? entity.relations.filter((r: any) => r.kind === "dependency")
                      .length + " 项已声明 MCP 依赖"
                  : "未声明 MCP 依赖"}
              </small>
            )}
            <small>{presentationLabels[entity.presentation.state]}</small>
          </div>
          <span className="d-tool-count">
            {entity.entityKind === "mcp_server"
              ? entity.toolCount == null
                ? "未知"
                : entity.toolCount + " 个"
              : "—"}
          </span>
          <button
            className="d-chevron"
            aria-label={"查看" + displayName(entity, english) + "详情"}
            onClick={() => onDetail(entity.id)}
          >
            <Icon name="chevron" />
          </button>
        </article>
      ))}
    </>
  );
}

export function PluginRelations({
  items,
  english,
  onDetail,
  api,
}: {
  items: Entity[];
  english: boolean;
  onDetail: (id: string) => void;
  api: Api;
}) {
  const [children, setChildren] = useState<Record<string, Entity[]>>({}),
    [error, setError] = useState("");
  useEffect(() => {
    let live = true;
    setChildren({});
    setError("");
    void Promise.all(
      items.map(async (item) => ({
        id: item.id,
        value: await api(
          "/api/v2/discovery/entities/" + encodeURIComponent(item.id),
        ),
      })),
    )
      .then((values) => {
        if (live)
          setChildren(
            Object.fromEntries(values.map((v) => [v.id, v.value.children])),
          );
      })
      .catch((e) => {
        if (live) setError(e.message);
      });
    return () => {
      live = false;
    };
  }, [items, api]);
  return (
    <>
      {error && <p role="alert">{error}</p>}
      <div className="d-plugin-grid">
        {items.map((plugin) => (
          <article className="d-plugin-card" key={plugin.id}>
            <div className="d-plugin-header">
              <span className="d-cap-icon plugin">
                <Icon name="plugin" />
              </span>
              <div>
                <h3>{displayName(plugin, english)}</h3>
                <span className="d-mono">{plugin.name}</span>
                <p>{displaySummary(plugin, english)}</p>
              </div>
              <Status entity={plugin} />
            </div>
            {children[plugin.id] ? (
              <div className="d-tree">
                {["mcp_server", "skill"].map((kind) => (
                  <div className="d-tree-group" key={kind}>
                    <p>
                      包含{" "}
                      {
                        children[plugin.id]!.filter(
                          (e) => e.entityKind === kind,
                        ).length
                      }{" "}
                      个{kind === "skill" ? " Skill" : " MCP 服务"}
                    </p>
                    {children[plugin.id]!.filter(
                      (e) => e.entityKind === kind,
                    ).map((entity) => (
                      <div className="d-tree-item" key={entity.id}>
                        <Icon name={kind} />
                        <button onClick={() => onDetail(entity.id)}>
                          {displayName(entity, english)}
                        </button>
                        <span
                          className={
                            "d-tag " + (kind === "skill" ? "purple" : "blue")
                          }
                        >
                          {kinds[kind]}
                        </span>
                      </div>
                    ))}
                  </div>
                ))}
                {!children[plugin.id]!.length && (
                  <p>清单尚未提供可识别组件。</p>
                )}
              </div>
            ) : (
              <p className="d-tree">正在读取插件组件…</p>
            )}
            <footer>
              <span>
                包含关系依据安装清单；Skill 的 MCP 依赖在详情中单独展示。
              </span>
              <button onClick={() => onDetail(plugin.id)}>
                插件详情 <Icon name="chevron" />
              </button>
            </footer>
          </article>
        ))}
      </div>
    </>
  );
}
