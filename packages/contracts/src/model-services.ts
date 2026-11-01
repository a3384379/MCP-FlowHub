export const OPENAI_BASE_URL = "https://api.openai.com/v1";
export const MODEL_SERVICES = [
  { id: "openai", name: "OpenAI（ChatGPT）", baseUrl: OPENAI_BASE_URL, protocol: "openai_responses", docsUrl: "https://developers.openai.com/api/docs/models" },
  { id: "custom", name: "自定义 OpenAI 兼容服务", baseUrl: "", protocol: "openai_compatible_chat", docsUrl: null },
] as const;

export function modelServiceId(baseUrl: string): "openai" | "custom" {
  try { return new URL(baseUrl).origin === "https://api.openai.com" ? "openai" : "custom"; }
  catch { return "custom"; }
}

export function modelErrorHint(code: string): string {
  return ({
    MODEL_AUTH_FAILED: "API Key 无效，或没有访问该服务的权限。请检查 API Key。",
    MODEL_NOT_AVAILABLE: "当前 Key 无法使用这个模型。请刷新模型列表后重新选择。",
    MODEL_ENDPOINT_NOT_FOUND: "模型接口地址不存在。请使用服务默认 Base URL，不要拼入其他协议的接口路径。",
    MODEL_QUOTA_EXCEEDED: "API 额度不足，请检查 OpenAI API 余额及项目预算。",
    MODEL_RATE_LIMITED: "模型服务限流，请稍后重试。",
    MODEL_INVALID_CONFIGURATION: "模型或请求参数不被当前接口支持，请核对协议并选择模型。",
    MODEL_UNSUPPORTED_TOOLS: "该模型不支持当前工具调用格式，可更换模型或仅用于问答。",
    MODEL_TIMEOUT: "请求超时，请检查网络或调整请求超时。",
    MODEL_STREAM_INTERRUPTED: "模型连接中途断开，已输出的回复和工具回执已保留。可以继续回复，不会重复执行原操作。",
    MODEL_CONNECTION_FAILED: "无法连接模型服务，请检查网络和 Base URL。",
    MODEL_REQUEST_FAILED: "模型服务拒绝请求，请检查协议、模型与 API 项目权限。",
    MODEL_OUTPUT_INVALID: "模型服务没有返回有效的目录或响应数据。",
    MODEL_CREDENTIAL_SCOPE_MISMATCH: "切换服务地址后请重新填写对应服务的 API Key；原 Key 会继续保留。",
    MODEL_NOT_CONFIGURED: "请先填写 API Key，或编辑已有且已配置 Key 的模型。",
    CREDENTIAL_LOCKED: "本机凭据库已锁定，请先解锁后重试；已保存的 Key 仍保留。",
  } as Record<string, string>)[code] ?? "请检查模型设置后重试。";
}
