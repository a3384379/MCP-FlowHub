export type Api = (
  path: string,
  method?: string,
  body?: any,
  revision?: number,
) => Promise<any>;
export type Entity = Record<string, any>;
export const kinds: Record<string, string> = {
  mcp_server: "MCP 服务",
  mcp_tool: "MCP 工具",
  skill: "Skill 技能",
  plugin: "插件",
};
export const issueLabels: Record<string, string> = {
  CONFIG_PARSE_ERROR: "配置格式无法解析",
  SOURCE_UNREADABLE: "来源无法读取",
  CODEX_NOT_FOUND: "未找到 Codex",
  EXECUTION_LOCATION_UNSUPPORTED: "当前上下文的运行位置与本机不一致",
  PLUGIN_MANIFEST_UNSUPPORTED: "插件清单格式暂不支持",
  PLUGIN_MARKETPLACE_UNSUPPORTED: "插件市场清单格式暂不支持",
  PLUGIN_MARKETPLACE_AMBIGUOUS: "插件市场来源存在冲突",
  PLUGIN_VERSION_AMBIGUOUS: "无法唯一确定插件版本",
  STATIC_RESOLUTION_PARTIAL: "当前使用静态配置，生效范围尚未完全确认",
  STATIC_PROFILE_PARTIAL: "Profile 的生效配置尚未完全确认",
  APP_SERVER_PARTIAL: "宿主目录读取不完整",
  HOST_SKILLS_PARTIAL: "Codex 技能目录读取不完整",
  CODEX_AUTH_REQUIRED: "Codex 授权需恢复",
  HOST_VERSION_UNSUPPORTED: "当前设置无法读取 Codex 工具目录",
  HOST_CATALOG_PARTIAL: "宿主工具目录不完整",
  HOST_SOURCE_AMBIGUOUS: "宿主服务存在多个同名来源",
  SKILL_METADATA_INVALID: "技能介绍格式无法解析",
  SKILL_DEPENDENCY_INVALID: "技能依赖声明无法解析",
  CATALOG_NOT_SYNCED: "尚未同步工具目录",
  DIRECT_CATALOG_NOT_SYNCED: "FlowHub 直连目录待检测",
  CREDENTIALS_REQUIRED: "需要连接配置",
  credentials_required: "需要连接配置",
  unreachable: "连接暂不可达",
  unsupported: "需要手动登记连接",
  ambiguous: "服务来源无法唯一对应",
  SOURCE_CONFIGURATION_UNSUPPORTED: "当前连接配置需手动登记",
  HOST_CAPABILITY_UNAVAILABLE: "需要 Codex 宿主提供能力目录",
  CONNECTION_FAILED: "连接失败",
  TASK_INTERRUPTED: "上次扫描被中断",
  DISCOVERY_CANCELLED: "扫描已取消或超时",
  SOURCE_STALE: "此来源未在当前扫描中确认，保留旧资料供查看",
};
export const presentationLabels: Record<string, string> = {
  localized: "中文已同步",
  manually_edited: "手工中文说明",
  pending: "待中文整理",
  stale: "中文说明待更新",
  original: "原始中文介绍",
};
export function hostCatalogReason(entity: Entity) {
  if (entity.hostAuthRequired || entity.hostCatalogStatus === "auth_required")
    return "Codex 授权需恢复";
  if (entity.hostCatalogStatus === "ambiguous" || entity.ambiguousSource)
    return "Codex 服务来源无法唯一对应";
  if (entity.hostCatalogStatus === "partial")
    return "Codex 工具目录读取不完整";
  if (entity.hostCatalogStatus === "unavailable")
    return "当前 Codex 目录未列出此服务";
  return "";
}
export function entityStatus(e: Entity) {
  const hostReason = hostCatalogReason(e);
  if (e.enabled && hostReason && (e.entityKind === "mcp_tool" || e.hostAuthRequired || !e.preparedConnectionId))
    return { text: hostReason, tone: "amber" };
  if (e.stale) return { text: "来源已失效 / 待同步", tone: "gray" };
  if (e.self) return { text: "FlowHub 自身 · 禁止导入", tone: "gray" };
  if (e.installation === "available_only")
    return { text: e.marketplaceConflict ? "市场来源冲突 · 未安装" : e.availability === "unavailable" ? "市场策略不可用 · 未安装" : "可用，尚未安装", tone: e.marketplaceConflict ? "amber" : "gray" };
  if (e.entityKind === "plugin" && e.marketplaceConflict)
    return { text: e.enabled === false ? "已安装 · 已停用 · 市场来源冲突" : "已安装 · 市场来源冲突", tone: "amber" };
  if (e.ambiguousSource || e.availability === "ambiguous") return { text: "来源待确认", tone: "amber" };
  if (!e.enabled) return { text: "已停用", tone: "gray" };
  if (e.hostCatalogReady) return { text: "由 Codex 执行", tone: "purple" };
  if (e.entityKind === "mcp_server" && e.hostCatalogStatus === "ready")
    return { text: "Codex 目录已同步", tone: "purple" };
  if (e.importState)
    return {
      text: e.importState.verified
        ? "已导入 · 绑定已验证"
        : e.importState.mockVerified
          ? "已导入 · Mock 已验证"
          : "已导入 · 绑定未验证",
      tone: e.importState.verified ? "green" : "blue",
    };
  if (e.entityKind === "plugin") return { text: "已安装", tone: "green" };
  if (e.entityKind === "mcp_server" && !e.preparedConnectionId && ["credentials_required", "unsupported", "not_checked"].includes(e.availability))
    return { text: "Codex 目录待同步", tone: "gray" };
  if (e.availability === "credentials_required")
    return { text: "需要连接配置", tone: "amber" };
  if (e.availability === "unsupported")
    return { text: "需手动登记连接", tone: "amber" };
  if (e.availability === "unreachable")
    return { text: "连接暂不可达", tone: "amber" };
  if (
    e.availability === "host_only" ||
    (e.executor === "codex_host" && e.entityKind === "skill")
  )
    return { text: "仅 Codex 调用", tone: "purple" };
  if (e.availability === "ready")
    return { text: "可导入 FlowHub", tone: "green" };
  return { text: "待同步工具", tone: "gray" };
}
export function Icon({ name }: { name: string }) {
  const paths: Record<string, React.ReactNode> = {
    mcp_server: (
      <>
        <rect x="4" y="3" width="16" height="7" rx="2" />
        <rect x="4" y="14" width="16" height="7" rx="2" />
        <path d="M7 6.5h.01M7 17.5h.01M11 6.5h5M11 17.5h5" />
      </>
    ),
    skill: (
      <path d="m12 3 2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3z" />
    ),
    plugin: <path d="M8 3v5M16 3v5M5 8h14v3a7 7 0 0 1-14 0V8zM12 18v4" />,
    refresh: (
      <path d="M20 7v5h-5M4 17v-5h5M6.5 6.5A8 8 0 0 1 20 12M4 12a8 8 0 0 0 13.5 5.5" />
    ),
    download: <path d="M12 3v12m-4-4 4 4 4-4M4 16v4h16v-4" />,
    chevron: <path d="m9 6 6 6-6 6" />,
    search: (
      <>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5 5" />
      </>
    ),
    close: <path d="m6 6 12 12M18 6 6 18" />,
    issue: <path d="m12 3 10 18H2L12 3zM12 9v5M12 17h.01" />,
    info: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v6M12 7h.01" />
      </>
    ),
    globe: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3a18 18 0 0 1 0 18 18 18 0 0 1 0-18z" />
      </>
    ),
    mcp_tool: (
      <path d="M14 6a5 5 0 0 0-6 6L3 17v4h4l5-5a5 5 0 0 0 6-6l-4 3-3-3 3-4z" />
    ),
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      {paths[name] ?? paths.info}
    </svg>
  );
}
export function Status({ entity }: { entity: Entity }) {
  const status = entityStatus(entity);
  return (
    <span className={"d-tag " + status.tone}>
      <i />
      {status.text}
    </span>
  );
}
export const displayName = (entity: Entity, english: boolean) =>
  english ? entity.name : entity.displayName || entity.name;
export const displaySummary = (entity: Entity, english: boolean) =>
  (english ? entity.description : entity.summary) ||
  "来源未提供介绍，可查看详情与工具目录。";
