import { useEffect, useState } from "react";

export function DiscoverySettings({
  context,
  busy,
  registering,
  register,
  expanded,
  onToggle,
}: {
  context: any;
  busy: boolean;
  registering: boolean;
  register: (form: any, update?: boolean) => Promise<void>;
  expanded: boolean;
  onToggle: (open: boolean) => void;
}) {
  const [form, setForm] = useState({
    codexHome: "",
    cwd: "",
    profile: "",
    codexPath: "",
    discoveryMode: "auto",
    projectTrusted: false,
    useAppServer: false,
  });
  useEffect(() => {
    if (context)
      setForm({
        codexHome: context.codexHome,
        cwd: context.canonicalCwd,
        profile: context.profile ?? "",
        codexPath: context.codexPath ?? "",
        discoveryMode: context.discoveryMode ?? "auto",
        projectTrusted: context.projectTrusted,
        useAppServer: context.useAppServer,
      });
  }, [context?.id, context?.revision]);
  return (
    <details
      id="discovery-settings"
      className="d-settings"
      open={expanded}
      onToggle={(e) => onToggle(e.currentTarget.open)}
    >
      <summary>登记本机 Codex 上下文</summary>
      <p>
        只读取当前机器的配置。项目目录、Codex 版本与 Profile
        决定读取范围；登记不会修改 Codex 配置。
        清空 Profile 会移除 Profile，CLI 模式中清空可执行文件路径会重新自动查找；身份变化时请登记新上下文。
      </p>
      <div className="d-settings-grid">
        {(
          [
            ["codexHome", "Codex Home（留空使用默认）"],
            ["cwd", "项目目录（留空使用当前目录）"],
            ["profile", "Profile（可选）"],
          ] as const
        ).map(([key, label]) => (
          <label key={key}>
            {label}
            <input
              disabled={registering}
              value={form[key]}
              onChange={(e) => setForm({ ...form, [key]: e.target.value })}
            />
          </label>
        ))}
        <label>
          发现模式
          <select
            disabled={registering}
            aria-label="发现模式"
            value={form.discoveryMode}
            onChange={(e) =>
              setForm({
                ...form,
                discoveryMode: e.target.value,
                useAppServer:
                  e.target.value === "config_only" ? false : form.useAppServer,
              })
            }
          >
            <option value="auto">使用 Codex CLI</option>
            <option value="config_only">仅配置，不启动 Codex</option>
          </select>
        </label>
        <label>
          Codex 可执行文件绝对路径（留空自动查找）
          <input
            disabled={registering || form.discoveryMode === "config_only"}
            value={form.codexPath}
            onChange={(e) => setForm({ ...form, codexPath: e.target.value })}
          />
        </label>
      </div>
      <label className="d-check">
        <input
          type="checkbox"
          disabled={registering}
          checked={form.projectTrusted}
          onChange={(e) =>
            setForm({ ...form, projectTrusted: e.target.checked })
          }
        />
        读取我信任的项目配置和 Skills
      </label>
      <label className="d-check">
        <input
          type="checkbox"
          disabled={registering || form.discoveryMode === "config_only"}
          checked={form.useAppServer}
          onChange={(e) => setForm({ ...form, useAppServer: e.target.checked })}
        />
        补充查询独立 App Server 会话目录
      </label>
      <div className="d-actions">
        <button disabled={busy || registering} onClick={() => void register(form)}>
          {registering ? "正在登记…" : "登记上下文"}
        </button>
        <button
          disabled={busy || registering || !context}
          onClick={() => void register(form, true)}
        >
          更新当前上下文的读取选项
        </button>
      </div>
    </details>
  );
}
