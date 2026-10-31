import { useEffect, useRef, useState } from "react";

type Api = (path: string, method?: string, body?: unknown) => Promise<any>;
type Integration = { codexToml: string; claudeJson: string; tokenFile: string };
type Client = {
  id: string;
  label: string;
  revoked: boolean;
  workflowAllowlist: string[];
  hostIntegration: Integration | null;
};
type Backup = {
  filename: string;
  path: string;
  sizeBytes: number;
  modifiedAt: string;
};

export type SettingsIntegrationProps = {
  api: Api;
  workflows: { id: string; name: string }[];
  disabled?: boolean;
};

const toolPurposes: Record<string, string> = {
  workflow_search: "查询可执行方案",
  workflow_get: "读取版本、输入与节点",
  workflow_start: "启动指定方案",
  workflow_advance: "提交 Agent 检查点结果",
  workflow_status: "读取运行状态与事件",
  workflow_cancel: "取消本人运行",
  artifact_read: "分块读取运行产物",
};
const size = (bytes: number) =>
  bytes < 1024 ? bytes + " B" : (bytes / 1024 / 1024).toFixed(2) + " MiB";

export function SettingsIntegration({
  api,
  workflows,
  disabled = false,
}: SettingsIntegrationProps) {
  const [settings, setSettings] = useState<any>(null);
  const [clients, setClients] = useState<Client[]>([]);
  const [clientId, setClientId] = useState("");
  const [label, setLabel] = useState("我的 Codex");
  const [allowlist, setAllowlist] = useState<string[]>([]);
  const [format, setFormat] = useState("codex");
  const [backups, setBackups] = useState<Backup[]>([]);
  const [directory, setDirectory] = useState("");
  const [backupName, setBackupName] = useState("");
  const [preflight, setPreflight] = useState<any>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const text = useRef<HTMLTextAreaElement>(null);
  const commandText = useRef<HTMLTextAreaElement>(null);
  const busy = disabled || pending;
  const client = clients.find((item) => item.id === clientId && !item.revoked);
  const config = client?.hostIntegration;

  useEffect(() => {
    let current = true;
    setPending(true);
    void Promise.all([api("/settings"), api("/clients"), api("/backups")])
      .then(([s, c, b]) => {
        if (!current) return;
        setSettings(s);
        setClients(c);
        setClientId(c.find((item: Client) => !item.revoked)?.id ?? "");
        setBackups(b.files);
        setDirectory(b.directory);
        setBackupName(b.files[0]?.filename ?? "");
      })
      .catch((e: Error) => current && setError(e.message))
      .finally(() => current && setPending(false));
    return () => {
      current = false;
    };
  }, [api]);

  async function run(action: () => Promise<void>) {
    setPending(true);
    setError("");
    setNotice("");
    try {
      await action();
    } catch (e) {
      setError(e instanceof Error ? e.message : "请求失败");
    } finally {
      setPending(false);
    }
  }
  async function refreshBackups() {
    const value = await api("/backups");
    setBackups(value.files);
    setDirectory(value.directory);
    return value.files as Backup[];
  }
  async function copy(value: string, element: HTMLTextAreaElement | null) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice("已复制到剪贴板");
    } catch {
      element?.focus();
      element?.select();
      setNotice("浏览器未允许复制，已选中文本，请手动复制。");
    }
  }

  return (
    <>
      <section className="panel" aria-labelledby="host-integration-heading">
        <span className="badge green">单入口 · 固定工具（个人编排 21 / 执行 7）</span>
        <h2 id="host-integration-heading">接入 Codex</h2>
        <p>
          先启动本机 daemon，再让宿主启动 STDIO
          薄桥。为每个宿主创建独立身份，并明确选择允许执行的方案。
        </p>
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        {notice && (
          <p className="info" role="status">
            {notice}
          </p>
        )}
        <label className="field">
          宿主身份名称
          <input
            value={label}
            maxLength={128}
            onChange={(e) => setLabel(e.target.value)}
            disabled={busy}
          />
        </label>
        <fieldset disabled={busy}>
          <legend>允许执行的方案（至少选择一项）</legend>
          {workflows.length === 0 && <p>尚无方案，请先创建工作流。</p>}
          {workflows.map((workflow) => (
            <label key={workflow.id} style={{ display: "block" }}>
              <input
                type="checkbox"
                checked={allowlist.includes(workflow.id)}
                onChange={(e) =>
                  setAllowlist(
                    e.target.checked
                      ? [...allowlist, workflow.id]
                      : allowlist.filter((id) => id !== workflow.id),
                  )
                }
              />
              {workflow.name} <small>({workflow.id})</small>
            </label>
          ))}
        </fieldset>
        <div className="actions">
          <button
            disabled={busy || !label.trim() || allowlist.length === 0}
            onClick={() =>
              void run(async () => {
                const created = await api("/clients", "POST", {
                  label: label.trim(),
                  workflowAllowlist: allowlist,
                });
                setClients(await api("/clients"));
                setClientId(created.id);
                setFormat("codex");
                setNotice("独立身份已创建；下方配置已绑定该身份的令牌文件。");
              })
            }
          >
            创建受限宿主身份
          </button>
        </div>
        <label className="field">
          查看宿主接入配置
          <select
            value={clientId}
            disabled={busy}
            onChange={(e) => setClientId(e.target.value)}
          >
            <option value="">请选择受限宿主身份</option>
            {clients
              .filter((item) => !item.revoked)
              .map((item) => (
                <option key={item.id} value={item.id}>
                  {item.label} · {item.id}
                </option>
              ))}
          </select>
        </label>
        {config && (
          <>
            <p>授权方案：{client!.workflowAllowlist.join("、")}</p>
            <label className="field">
              宿主配置格式
              <select
                value={format}
                onChange={(e) => setFormat(e.target.value)}
              >
                <option value="codex">Codex · config.toml</option>
                <option value="claude">Claude Desktop · JSON</option>
              </select>
            </label>
            <p>
              {format === "codex"
                ? "将此段合并到当前本机用户的 ~/.codex/config.toml；已有 flowhub 条目时先检查并替换该条目。"
                : "将此 mcpServers 条目合并到 Claude Desktop 的 MCP 配置，保留已有服务。"}
            </p>
            <textarea
              ref={text}
              aria-label="宿主接入配置"
              spellCheck={false}
              readOnly
              rows={10}
              value={format === "codex" ? config.codexToml : config.claudeJson}
            />
            <div className="actions">
              <button
                onClick={() =>
                  void copy(
                    format === "codex" ? config.codexToml : config.claudeJson,
                    text.current,
                  )
                }
              >
                复制接入配置
              </button>
            </div>
            <p style={{ overflowWrap: "anywhere" }}>
              令牌文件引用：<code>{config.tokenFile}</code>
            </p>
            <p>
              配置包含当前机器的真实路径与 <code>--token-file</code>{" "}
              引用，不包含令牌内容。请在安装 FlowHub
              的同一台机器使用此配置；迁移到其他机器后重新生成。
            </p>
          </>
        )}
        {clients.length > 0 && (
          <details>
            <summary>管理宿主权限与撤销</summary>
            {clients.map((item) => (
              <div key={item.id}>
                <p>
                  <strong>{item.label}</strong> ·{" "}
                  {item.revoked ? "已撤销" : "有效"}
                  <br />
                  <small>{item.workflowAllowlist.join("、")}</small>
                </p>
                <button
                  disabled={busy || item.revoked}
                  onClick={() =>
                    void run(async () => {
                      await api("/clients/" + item.id + "/revoke", "POST", {});
                      setClients(await api("/clients"));
                      if (clientId === item.id) setClientId("");
                      setNotice("宿主身份已撤销，新的执行请求将被拒绝。");
                    })
                  }
                >
                  撤销 {item.label}
                </button>
              </div>
            ))}
          </details>
        )}
        <details>
          <summary>固定工具（个人编排 21 / 执行 7）及用途</summary>
          <ul>
            {(settings?.tools ?? []).map((name: string) => (
              <li key={name}>
                <code>{name}</code>：{toolPurposes[name] ?? "工作流工具"}
              </li>
            ))}
          </ul>
        </details>
        <p className="info">
          {settings?.hostVerification?.message ?? "真实 Codex 接入尚未验证。"}
        </p>
        <p>
          宿主分析收到的证据可能进入模型服务。真实数据的使用需遵循组织授权。
        </p>
      </section>
      <section className="panel" aria-labelledby="local-backup-heading">
        <h2 id="local-backup-heading">本机数据与备份</h2>
        <p style={{ overflowWrap: "anywhere" }}>
          数据目录：<code>{settings?.dataDir ?? "正在读取"}</code>
          <br />
          数据库大小：{settings ? size(settings.databaseSizeBytes) : "正在读取"}
          <br />
          备份目录：<code>{directory || "正在读取"}</code>
        </p>
        <p>
          备份包含敏感状态，只保存在本机。使用 SQLite
          一致性备份，不要在运行中复制数据库文件。
        </p>
        <div className="actions">
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const created = await api("/backups", "POST", {});
                await refreshBackups();
                setBackupName(created.filename);
                setPreflight(null);
                setNotice("一致性备份已保存到：" + created.path);
              })
            }
          >
            SQLite 一致性备份
          </button>
          <button
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const files = await refreshBackups();
                if (!files.some((file) => file.filename === backupName))
                  setBackupName(files[0]?.filename ?? "");
                setPreflight(null);
              })
            }
          >
            刷新备份列表
          </button>
        </div>
        {backups.length === 0 && (
          <p>当前数据目录还没有可预检的 SQLite 备份。</p>
        )}
        <label className="field">
          选择本机备份
          <select
            disabled={busy || backups.length === 0}
            value={backupName}
            onChange={(e) => {
              setBackupName(e.target.value);
              setPreflight(null);
            }}
          >
            <option value="">请选择备份</option>
            {backups.map((file) => (
              <option key={file.filename} value={file.filename}>
                {file.filename} · {size(file.sizeBytes)} ·{" "}
                {new Date(file.modifiedAt).toLocaleString()}
              </option>
            ))}
          </select>
        </label>
        {backupName && (
          <p style={{ overflowWrap: "anywhere" }}>
            文件位置：
            <code>
              {backups.find((file) => file.filename === backupName)?.path}
            </code>
          </p>
        )}
        <button
          disabled={busy || !backupName}
          onClick={() =>
            void run(async () => {
              setPreflight(null);
              setPreflight(
                await api("/backups/preflight", "POST", {
                  filename: backupName,
                }),
              );
            })
          }
        >
          只读恢复预检
        </button>
        {preflight && (
          <div>
            <p
              role="status"
              className={preflight.compatible ? "info" : "error"}
            >
              {preflight.compatible
                ? "预检通过：完整性与当前程序的迁移历史兼容。"
                : "预检未通过：" +
                  preflight.errorCode +
                  " · " +
                  preflight.message}
            </p>
            {preflight.instructions && (
              <>
                <h3>停止 daemon 后离线恢复</h3>
                <p>{preflight.instructions.notice}</p>
                <p>
                  当前 daemon PID：
                  <code>{preflight.instructions.daemonPid}</code>。运行中的
                  daemon 会拒绝恢复。
                </p>
                <ol>
                  {preflight.instructions.steps.map((step: string) => (
                    <li key={step}>{step}</li>
                  ))}
                </ol>
                <label className="field">
                  本机离线恢复命令（{preflight.instructions.shell}）
                  <textarea
                    ref={commandText}
                    readOnly
                    rows={5}
                    spellCheck={false}
                    value={preflight.instructions.restoreCommand}
                  />
                </label>
                <button
                  onClick={() =>
                    void copy(
                      preflight.instructions.restoreCommand,
                      commandText.current,
                    )
                  }
                >
                  复制离线恢复命令
                </button>
              </>
            )}
          </div>
        )}
      </section>
    </>
  );
}
