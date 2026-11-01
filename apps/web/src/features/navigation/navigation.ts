export const navigationGroups = [
  {
    id: "workspace",
    label: "工作区",
    items: [
      { key: "workflows", label: "工作流" },
      { key: "runs", label: "运行记录" },
    ],
  },
  {
    id: "capabilities",
    label: "能力与连接",
    items: [
      { key: "discovery", label: "能力发现" },
      { key: "connections", label: "MCP 服务" },
      { key: "bindings", label: "环境与资源" },
    ],
  },
  {
    id: "configuration",
    label: "系统配置",
    items: [
      { key: "models", label: "模型设置" },
      { key: "settings", label: "系统设置" },
    ],
  },
] as const;

export type NavigationKey =
  (typeof navigationGroups)[number]["items"][number]["key"];
export const navigationMedia = "(max-width: 760px)";

export function navigationForPage(page: string) {
  const key =
    page === "editor" ? "workflows" : page === "tools" ? "connections" : page;
  for (const group of navigationGroups) {
    const item = group.items.find((item) => item.key === key);
    if (item) return { ...item, group: group.label };
  }
  return undefined;
}

export function navigationLabel(page: string) {
  return page === "editor"
    ? "流程编排"
    : (navigationForPage(page)?.label ?? "FlowHub");
}
