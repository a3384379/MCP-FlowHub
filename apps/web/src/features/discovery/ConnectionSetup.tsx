import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Api, Entity } from "./shared";

type Choice = {
  mode: "new" | "existing" | "source";
  kind: string;
  label: string;
  value: string;
  secretRef: string;
};
const purposes: Record<string, string> = {
  model_api: "模型 Key",
  mcp_auth: "MCP 认证",
  mcp_config: "MCP 配置",
  unspecified: "用途待确认",
};
const message = (e: any) =>
  e.code === "CREDENTIAL_LOCKED"
    ? "本地库已锁定，请在此处解锁后继续。"
    : e.message;
const eligible = (s: Entity) =>
  s.eligibleForMcp !== false && !s.modelCredential && s.purpose !== "model_api";

/** Secret text lives only in this mounted form, and is saved with its binding. */
export function ConnectionSetup({
  api,
  entity,
  initialSecrets,
  formId,
  onBusy,
  onChanged,
  onManage,
}: {
  api: Api;
  entity: Entity;
  initialSecrets: Entity[];
  formId: string;
  onBusy: (value: boolean) => void;
  onChanged: () => Promise<void>;
  onManage: () => void;
}) {
  const [meta, setMeta] = useState<Entity | null>(null),
    [secrets, setSecrets] = useState(initialSecrets);
  const [choices, setChoices] = useState<Record<string, Choice>>({}),
    [locked, setLocked] = useState(false);
  const [password, setPassword] = useState(""),
    [working, setWorking] = useState(false),
    [bulk, setBulk] = useState(false);
  const [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [saved, setSaved] = useState<Entity | null>(null);
  const [stage, setStage] = useState(""),
    [uncertain, setUncertain] = useState(false);
  const mounted = useRef(false),
    pending = useRef<{ body: Entity; detect: boolean } | null>(null),
    busy = useRef(false);
  const updateBusy = (value: boolean) => {
    busy.current = value;
    setWorking(value);
    onBusy(value);
  };
  useEffect(() => {
    mounted.current = true;
    let alive = true;
    updateBusy(true);
    void api("/api/v2/capability-sources/" + entity.sourceId + "/configuration")
      .then((result) => {
        if (!alive) return;
        setMeta(result);
        setLocked(result.vaultLocked);
        setChoices(
          Object.fromEntries(
            result.fields.map((f: Entity) => [
              f.id,
              {
                mode: f.selectedRef
                  ? "existing"
                  : f.inline === true
                    ? "source"
                    : "new",
                kind: f.kind,
                label: (entity.name + " · " + f.name).slice(0, 128),
                value: "",
                secretRef: f.selectedRef ?? "",
              },
            ]),
          ),
        );
      })
      .catch((e) => {
        if (alive) setError(message(e));
      })
      .finally(() => {
        if (alive) updateBusy(false);
      });
    return () => {
      alive = false;
      mounted.current = false;
    };
  }, [entity.sourceId]);
  const change = (id: string, patch: Partial<Choice>) => {
    setChoices((old) => ({ ...old, [id]: { ...old[id], ...patch } }));
    setNotice("");
    setSaved(null);
  };
  const unlock = async () => {
    if (busy.current) return;
    updateBusy(true);
    setError("");
    try {
      await api("/vault/unlock", "POST", { password });
      if (!mounted.current) return;
      setLocked(false);
      setPassword("");
      setNotice("本地库已解锁，填写内容已保留。");
      window.dispatchEvent(new Event("flowhub-credentials-changed"));
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) updateBusy(false);
    }
  };
  const detect = async (receipt: Entity) => {
    setStage("检测连接并读取工具目录…");
    try {
      const result = await api(
        "/api/v2/capability-sources/" + entity.sourceId + "/detect",
        "POST",
        { expectedRevision: receipt.revision },
      );
      if (!mounted.current) return;
      setNotice(
        "配置已保存，本服务连接及目录检测通过，读取到 " +
          result.toolCount +
          " 个工具。资源绑定仍需独立验证。",
      );
      await onChanged();
    } catch (e) {
      if (mounted.current) {
        setNotice(
          "配置已保存，连接或目录检测未通过。可直接重试检测，无需重复保存。",
        );
        setError(message(e));
        if ((e as any).code === "CREDENTIAL_LOCKED") setLocked(true);
      }
    }
  };
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy.current || !meta) return;
    if (locked) {
      setError("请先在此处解锁本地库，已填写内容会保留。");
      return;
    }
    const wantsDetection =
      (event.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ===
      "detect";
    if (saved && !pending.current) {
      if (wantsDetection) await retryDetection();
      else setNotice("当前填写已保存，可直接检测连接。");
      return;
    }
    if (!pending.current) {
      const refs: Record<string, string> = {},
        entries: Record<string, Entity> = {};
      for (const field of meta.fields) {
        const choice = choices[field.id];
        if (choice.mode === "existing" && !choice.secretRef) {
          setError("请选择 " + field.name + " 的已有项，或填写新值。");
          return;
        }
        if (choice.mode === "new" && !choice.label.trim()) {
          setError("请填写 " + field.name + " 的名称。");
          return;
        }
        if (
          choice.mode === "new" &&
          !choice.value &&
          choice.kind !== "config"
        ) {
          setError("请填写 " + field.name + " 的值。");
          return;
        }
        if (choice.mode === "existing" && field.location === "env")
          refs[field.name] = choice.secretRef;
        entries[field.id] = {
          mode: choice.mode,
          kind: choice.kind,
          ...(choice.mode === "new"
            ? { label: choice.label, value: choice.value }
            : choice.mode === "existing"
              ? { secretRef: choice.secretRef }
              : {}),
        };
      }
      pending.current = {
        body: {
          expectedRevision: meta.revision,
          secretRefs: refs,
          entries,
          importInlineCredentials: false,
          idempotencyKey: crypto.randomUUID(),
        },
        detect: wantsDetection,
      };
    }
    const proposal = pending.current;
    updateBusy(true);
    setError("");
    setNotice("");
    setStage("保存连接配置…");
    let receipt: Entity;
    try {
      receipt = await api(
        "/api/v2/capability-sources/" + entity.sourceId + "/credentials",
        "POST",
        proposal.body,
      );
    } catch (e: any) {
      if (mounted.current) {
        if (e.status >= 400 && e.status < 500 && e.status !== 408) {
          pending.current = null;
          setUncertain(false);
        } else setUncertain(true);
        if (e.code === "CREDENTIAL_LOCKED") setLocked(true);
        setError(message(e));
        setStage("");
        updateBusy(false);
      }
      return;
    }
    if (!mounted.current) return;
    pending.current = null;
    setUncertain(false);
    setSaved(receipt);
    setMeta((old) => (old ? { ...old, revision: receipt.revision } : old));
    setChoices((old) =>
      Object.fromEntries(
        Object.entries(old).map(([id, value]) => [
          id,
          {
            ...value,
            mode: "existing",
            value: "",
            secretRef: receipt.entryRefs[id],
          },
        ]),
      ),
    );
    setNotice(
      "连接配置已保存。可检测连接并读取工具目录，资源绑定仍需独立验证。",
    );
    window.dispatchEvent(new Event("flowhub-credentials-changed"));
    try {
      const list = await api("/secrets");
      if (!mounted.current) return;
      setSecrets(list);
      await onChanged();
      if (!mounted.current) return;
      if (proposal.detect) await detect(receipt);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) {
        setStage("");
        updateBusy(false);
      }
    }
  };
  const retryDetection = async () => {
    if (!saved || busy.current) return;
    updateBusy(true);
    setError("");
    try {
      await detect(saved);
    } finally {
      if (mounted.current) {
        setStage("");
        updateBusy(false);
      }
    }
  };
  const disabled = working || uncertain;
  const fieldRow = (field: Entity) => {
    const choice = choices[field.id];
    if (!choice) return null;
    const matches = secrets.filter(
      (s) =>
        eligible(s) &&
        !(choice.kind === "credential" && s.purpose === "mcp_config") &&
        !(choice.kind === "config" && s.purpose === "mcp_auth"),
    );
    return (
      <section className="d-config-field" key={field.id}>
        <label>
          {field.title}
          {field.title !== field.name && <code>{field.name}</code>}
          <select
            aria-label={field.name}
            disabled={disabled}
            value={
              choice.mode === "existing" ? choice.secretRef : "$" + choice.mode
            }
            onChange={(e) =>
              change(
                field.id,
                e.target.value === "$source"
                  ? { mode: "source" }
                  : e.target.value === "$new"
                    ? { mode: "new" }
                    : { mode: "existing", secretRef: e.target.value },
              )
            }
          >
            <option value="">选择已有配置或凭据</option>
            {field.inline !== false && (
              <option value="$source">
                {field.inline === true
                  ? "使用来源已有值（加密保存）"
                  : "使用来源已有值（保存时核对）"}
              </option>
            )}
            <option value="$new">填写新值</option>
            {matches.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} · {purposes[s.purpose] ?? "用途待确认"}
              </option>
            ))}
            {choice.mode === "existing" &&
              choice.secretRef &&
              !matches.some((s) => s.id === choice.secretRef) && (
                <option value={choice.secretRef} disabled>
                  原引用不可用于 MCP，请重新选择
                </option>
              )}
          </select>
        </label>
        <p>
          {field.description}{" "}
          {field.documentationUrl && (
            <a href={field.documentationUrl} target="_blank" rel="noreferrer">
              配置说明
            </a>
          )}
        </p>
        {(field.kind === "unknown" || field.declaredKind === "unknown") && (
          <label>
            配置类型 · {field.name}
            <select
              aria-label={"配置类型 · " + field.name}
              disabled={disabled}
              value={choice.kind}
              onChange={(e) => change(field.id, { kind: e.target.value })}
            >
              <option value="unknown">用途待确认（按敏感值处理）</option>
              <option value="config">普通配置（已核对用途）</option>
              <option value="credential">认证凭据</option>
            </select>
          </label>
        )}
        {choice.mode === "new" ? (
          <div className="d-config-new">
            <label>
              名称
              <input
                aria-label={"名称 · " + field.name}
                maxLength={128}
                disabled={disabled}
                value={choice.label}
                onChange={(e) => change(field.id, { label: e.target.value })}
              />
            </label>
            <label>
              {choice.kind === "config" ? "配置值" : "凭据值"}
              <input
                aria-label={"值 · " + field.name}
                type={choice.kind === "config" ? "text" : "password"}
                autoComplete="off"
                maxLength={16383}
                disabled={disabled}
                value={choice.value}
                list={field.suggestions ? formId + field.id : undefined}
                onChange={(e) => change(field.id, { value: e.target.value })}
              />
            </label>
            {field.suggestions && (
              <datalist id={formId + field.id}>
                {field.suggestions.map((v: string) => (
                  <option key={v} value={v} />
                ))}
              </datalist>
            )}
            <small>填写值将在保存连接配置时与引用一并入库，均加密保存。</small>
          </div>
        ) : (
          <button
            type="button"
            disabled={disabled}
            onClick={() => change(field.id, { mode: "new" })}
          >
            新增并用于此项
          </button>
        )}
      </section>
    );
  };
  return (
    <form
      id={formId}
      className="d-edit-form d-connection-setup"
      onSubmit={(event) => void submit(event)}
    >
      <h3>连接配置</h3>
      <p>
        普通配置、认证凭据和待确认项分别填写，值均在本机加密保存。模型 Key
        在模型设置中单独管理。
      </p>
      <div className="d-vault-status">
        本地库：{locked ? "已锁定" : meta ? "已解锁" : "正在读取…"}
      </div>
      {locked && (
        <div className="d-config-unlock">
          <label>
            凭据库口令
            <input
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void unlock();
                }
              }}
              aria-label="凭据库口令"
              type="password"
              autoComplete="current-password"
              disabled={working}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button
            type="button"
            disabled={working || !password}
            onClick={() => void unlock()}
          >
            解锁凭据库
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="d-notice">
          {notice}
        </p>
      )}
      {stage && <p role="status">{stage}</p>}
      {uncertain && (
        <p role="status">
          保存结果尚未确认，请使用原请求重试；填写内容已保留。
        </p>
      )}
      {meta && meta.revision !== entity.configurationRevision && (
        <p className="d-notice">
          来源修订与当前目录不同。当前填写保留读取时的版本，冲突时请保留输入并重新核对。
        </p>
      )}
      {secrets.some((s) => !eligible(s)) && (
        <p className="d-muted">模型专用 Key 已从此处的可选列表中排除。</p>
      )}
      {meta &&
        ["config", "credential", "unknown"].map((kind) => {
          const list = meta.fields.filter((f: Entity) => f.kind === kind);
          return list.length ? (
            <div key={kind} className="d-config-group">
              <h4>
                {kind === "config"
                  ? "普通配置"
                  : kind === "credential"
                    ? "认证凭据"
                    : "用途待确认"}
              </h4>
              {list.map(fieldRow)}
            </div>
          ) : null;
        })}
      {meta?.fields.length === 0 && (
        <p>此服务未声明需要填写的配置项，可保存并检测连接。</p>
      )}
      <label className="d-check">
        <input
          type="checkbox"
          disabled={disabled}
          checked={bulk}
          onChange={(e) => {
            setBulk(e.target.checked);
            setSaved(null);
            setNotice("");
            const next = { ...choices };
            for (const field of meta?.fields ?? [])
              if (field.inline !== false)
                next[field.id] = {
                  ...next[field.id],
                  mode: e.target.checked
                    ? "source"
                    : next[field.id].secretRef
                      ? "existing"
                      : "new",
                };
            setChoices(next);
          }}
        />
        使用来源已有配置（加密保存）
      </label>
      <div className="d-actions">
        <button type="button" disabled={working} onClick={onManage}>
          管理配置与凭据库
        </button>
        {saved && (
          <button
            type="button"
            disabled={working}
            onClick={() => void retryDetection()}
          >
            重试检测
          </button>
        )}
      </div>
      <p className="d-muted">
        检测只读取本服务工具目录。配置保存、目录检测与资源绑定验证分别记录。
      </p>
    </form>
  );
}
