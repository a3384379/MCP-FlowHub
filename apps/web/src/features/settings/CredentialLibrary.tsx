import { useEffect, useRef, useState } from "react";
import type { Api } from "../../shared/v2";

const labels: Record<string, string> = {
  all: "全部",
  mcp_auth: "MCP 认证",
  mcp_config: "MCP 配置",
  model_api: "模型 Key",
  unspecified: "用途待确认",
};
export function CredentialLibrary({
  api,
  onCreate,
  onUnlock,
  onLock,
  onRotate,
}: {
  api: Api;
  onCreate: () => void;
  onUnlock: () => void;
  onLock: () => void;
  onRotate: () => void;
}) {
  const [items, setItems] = useState<any[]>([]),
    [locked, setLocked] = useState(true),
    [tab, setTab] = useState("all");
  const [error, setError] = useState(""),
    [loading, setLoading] = useState(true),
    generation = useRef(0);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const version = ++generation.current;
      try {
        const [records, state] = await Promise.all([
          api("/secrets"),
          api("/auth/state"),
        ]);
        if (!alive || version !== generation.current) return;
        setItems(records);
        setLocked(state.vaultLocked);
        setError("");
      } catch (e) {
        if (alive && version === generation.current)
          setError((e as Error).message);
      } finally {
        if (alive && version === generation.current) setLoading(false);
      }
    };
    void load();
    const changed = (event: Event) => {
      if (event instanceof CustomEvent && event.detail?.createdId)
        setTab(event.detail.purpose ?? "all");
      void load();
    };
    window.addEventListener("flowhub-credentials-changed", changed);
    return () => {
      alive = false;
      window.removeEventListener("flowhub-credentials-changed", changed);
    };
  }, [api]);
  const visible = items.filter(
    (item) =>
      tab === "all" ||
      (tab === "model_api"
        ? item.modelCredential
        : item.purpose === tab || item.purposes?.includes(tab)),
  );
  return (
    <section id="credential-library" tabIndex={-1} className="panel credential-library">
      <div className="credential-library-head">
        <h2>配置与凭据库</h2>
        <button className="primary" onClick={locked ? onUnlock : onCreate}>
          新增配置或凭据
        </button>
      </div>
      <p>
        本地库{locked ? "已锁定" : "已解锁"} ·
        所有值均加密保存，列表只显示名称和使用位置。
      </p>
      <div className="actions">
        <button onClick={onUnlock}>解锁</button>
        <button onClick={onLock}>立即锁定</button>
        <button onClick={onRotate}>修改口令</button>
      </div>
      <div
        className="segments credential-library-tabs"
        aria-label="凭据用途筛选"
      >
        {Object.entries(labels).map(([key, label]) => (
          <button
            key={key}
            aria-pressed={tab === key}
            className={tab === key ? "active" : ""}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {loading ? (
        <p role="status">正在读取本地库…</p>
      ) : !visible.length ? (
        <p>此分类暂无条目。可在此新增，或在 MCP 的连接配置中直接填写并保存。</p>
      ) : (
        <div className="credential-library-list">
          {visible.map((item) => (
            <article key={item.id}>
              <div>
                <strong>{item.label}</strong>
                <small>
                  {labels[item.modelCredential ? "model_api" : item.purpose] ??
                    labels.unspecified}{" "}
                  · 已加密保存
                </small>
              </div>
              <div>
                {item.usedBy?.length ? (
                  <details>
                    <summary>{item.usedBy.length} 处引用</summary>
                    {item.usedBy.map((usage: any, i: number) => (
                      <p key={i}>
                        {usage.name}
                        {usage.variable ? " · " + usage.variable : ""} ·{" "}
                        {labels[usage.kind] ?? labels.unspecified}
                      </p>
                    ))}
                  </details>
                ) : (
                  <span>尚未绑定服务</span>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
      <p>
        模型 Key 在模型设置中维护。旧条目按实际引用关系展示用途，原 ID
        和加密数据保持不变。
      </p>
    </section>
  );
}
