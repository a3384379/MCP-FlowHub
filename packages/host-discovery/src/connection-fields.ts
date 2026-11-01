import { basename } from "node:path";
import type { Json } from "../../contracts/src/domain.js";

const cbmDocs =
  "https://github.com/DeusData/codebase-memory-mcp/blob/main/docs/CONFIGURATION.md";
// Reviewed public declarations, not a name-based secret detector. Unknown
// variables remain unknown and every supplied value is still encrypted.
export function configurationFields(config: Json, serverName = ""): Json[] {
  const fields = new Map<string, Json>();
  const cbm =
    serverName === "codebase-memory-mcp" ||
    /^codebase-memory-mcp(?:\.exe)?$/.test(basename(config.command ?? ""));
  for (const name of [
    ...new Set([...(config.env_vars ?? []), ...Object.keys(config.env ?? {})]),
  ]) {
    const known =
      cbm && ["CBM_ALLOWED_ROOT", "CBM_LOG_LEVEL"].includes(String(name));
    fields.set(String(name), {
      id: "env:" + name,
      name,
      kind: known ? "config" : "unknown",
      location: "env",
      inline: Object.hasOwn(config.env ?? {}, String(name)),
      title: known
        ? name === "CBM_ALLOWED_ROOT"
          ? "允许访问的目录"
          : "日志级别"
        : name,
      description: known
        ? name === "CBM_ALLOWED_ROOT"
          ? "限制可索引的目录范围。请填写本机对应路径。"
          : "按当前服务版本设置日志级别；保留来源原值。"
        : "来源未声明用途，请按该服务说明确认；值仍加密保存。",
      ...(known
        ? {
            documentationUrl: cbmDocs,
            ...(name === "CBM_LOG_LEVEL"
              ? {
                  suggestions: [
                    "debug",
                    "info",
                    "warn",
                    "error",
                    "none",
                    "0",
                    "1",
                    "2",
                    "3",
                    "4",
                  ],
                }
              : {}),
          }
        : {}),
    });
  }
  for (const name of [
    ...Object.values(config.env_http_headers ?? {}),
    ...(config.bearer_token_env_var ? [config.bearer_token_env_var] : []),
  ]) {
    fields.set(String(name), {
      id: "env:" + name,
      name,
      title: name,
      kind: "credential",
      location: "env",
      inline: Object.hasOwn(config.env ?? {}, String(name)),
      description: "来源明确将此变量用于 HTTP 认证。",
    });
  }
  if (Object.keys(config.http_headers ?? {}).length)
    fields.set("$bearer", {
      id: "bearer",
      name: "HTTP Bearer Token",
      title: "HTTP Bearer Token",
      kind: "credential",
      location: "bearer",
      inline: true,
      description: "来源中的 HTTP 认证值，仅在本机加密保存。",
    });
  return [...fields.values()];
}

export function storedConfigurationFields(source: Json): Json[] {
  if (Array.isArray(source.configurationFields))
    return source.configurationFields;
  return configurationFields(
    { env_vars: source.credentialVariables ?? [] },
    source.name,
  ).map((f) => ({ ...f, inline: null }));
}
