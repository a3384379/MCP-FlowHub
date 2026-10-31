export type DiscoveryDestination = {
  type: "connection" | "vault" | "unlock";
  name?: string;
};
export type Issue = Record<string, any>;
export function issueAction(issue: Issue) {
  const code = issue.code;
  if (
    ["credentials_required", "CREDENTIALS_REQUIRED"].includes(code) &&
    !issue.connectionSetup
  )
    return {
      type: "rescan",
      label: "更新连接状态",
      help: "旧快照尚未区分凭据引用与手动连接。先重新读取当前配置，再按更新后的处理按钮操作。",
    };
  if (
    [
      "unsupported",
      "SOURCE_CONFIGURATION_UNSUPPORTED",
      "CREDENTIAL_IMPORT_UNSUPPORTED",
    ].includes(code) ||
    (["credentials_required", "CREDENTIALS_REQUIRED"].includes(code) &&
      issue.connectionSetup === "manual")
  )
    return {
      type: "connection",
      label: "手动连接",
      help: "此启动或认证配置不能直接导入。为该服务登记独立连接，再检测工具目录；Codex 原配置仍需在来源中修改。",
    };
  if (
    ["credentials_required", "CREDENTIALS_REQUIRED"].includes(code) &&
    issue.entityId &&
    issue.executor === "hub_direct"
  )
    return {
      type: "credentials",
      label: "配置凭据",
      help: "选择本地凭据引用并保存，再同步工具目录。没有凭据时可先添加，凭据库锁定时可直接解锁。",
    };
  if (code === "CATALOG_NOT_SYNCED" && issue.executor !== "codex_host")
    return {
      type: "sync",
      label: "同步工具目录",
      help: "连接当前上下文的服务，读取工具定义；不会调用业务工具。同步完成后自动更新本列表。",
    };
  if (["unreachable", "CONNECTION_FAILED"].includes(code))
    return {
      type: "sync",
      label: "重新同步目录",
      help: "确认服务已启动、地址和网络可用后重新同步。这会检测当前上下文的服务并读取工具定义；需要独立修改地址或启动方式时，使用“手动连接”。",
    };
  if (
    ["SOURCE_STALE", "TASK_INTERRUPTED", "DISCOVERY_CANCELLED"].includes(code)
  )
    return {
      type: "rescan",
      label: "重新扫描",
      help: "重新读取来源，确认它是否仍存在。旧资料保留；来源恢复并同步后再使用。",
    };
  if (
    [
      "CODEX_NOT_FOUND",
      "STATIC_PROFILE_PARTIAL",
      "STATIC_RESOLUTION_PARTIAL",
      "APP_SERVER_PARTIAL",
      "HOST_CATALOG_PARTIAL",
      "EXECUTION_LOCATION_UNSUPPORTED",
    ].includes(code)
  )
    return {
      type: "settings",
      label: "检查发现设置",
      help: "检查本页的 Codex 路径、项目目录和 Profile；宿主目录不完整时，可启用独立 App Server 会话目录后重新扫描。",
    };
  if (issue.executor === "codex_host" || code === "HOST_CAPABILITY_UNAVAILABLE")
    return {
      type: "guide",
      label: "查看宿主接入方式",
      help: "该能力需要 Codex 宿主提供。先在 Codex 中配置并启用对应插件或 MCP，再检查本页发现设置并同步；不能把宿主 OAuth 当作 FlowHub 独立连接凭据。",
    };
  return {
    type: "guide",
    label: "查看处理方法",
    help: "按来源位置检查配置或插件、技能文件，修正后重新扫描。FlowHub 只读发现，不会替你改写 Codex 源文件。",
  };
}
