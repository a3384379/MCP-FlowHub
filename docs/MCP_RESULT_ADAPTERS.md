# MCP 结果适配、环境来源与派发限额

工具发现只证明 SDK 能读取 tools/list，不等于结果契约已兼容或服务实时在线。绑定的高级区可配置按工具名称索引的 `toolAdapters`；当前实现仅支持版本 1，不执行脚本、表达式或结果中的指令。

```json
{
  "read_records": {
    "version": 1,
    "format": "structured",
    "environment": { "source": "payload", "pointer": "/context/environment" },
    "rowLimit": { "argumentPointer": "/limit" }
  }
}
```

`structured` 读取对象形式的 structuredContent，并先校验工具声明的 outputSchema。可额外声明 `payloadSchema` 进一步约束业务数据；没有工具 outputSchema 时，显式适配器必须提供 payloadSchema。映射和后继节点使用实际业务对象，不会补写 environment 等字段。

`text_json` 仅适用于未声明结构化 outputSchema 的工具，必须提供 payloadSchema；只接受恰好一个文本块中的完整 JSON 对象。多个文本块、混合内容、无效 JSON、工具错误和超大结果均拒绝，不猜选某段文本。适配结果上限为 256 KiB；HTTP 响应以流计数并在 1 MiB 上限停止读取，STDIO 同样有有界接收缓冲；工作流本身的更小输出预算继续在持久化前校验。无法确定的外部结果不自动重试。

环境来源可选：

- `payload`：使用明确 JSON Pointer 核对结果中的环境证据；仍需独立验证端点、账号和固定资源，返回一个 environment 标签本身不是权限证明。
- `binding`：适合不返回环境字段的普通业务结果。验证请求需提供 `sourceAttestation` 的 `serviceIdentity`、`accountScope` 和 `resourceScope`。管理员须独立核验这些声明；系统将其与实际连接配置摘要、连接及绑定修订和适配器摘要关联。生产还必须有独立凭据引用与固定资源参数。未完成核验不能以给业务对象补 environment 的方式放行。结果若主动声明了冲突环境，仍会拒绝。

环境来源记录单独保存在证据的 verification.source 中。它用于追溯调用来源，不是对业务结论、服务端权限或管理员声明真实性的自动认证。MOCK_VERIFIED 不代表企业生产验证。

派发前行数限制必须明示真实能力：

- 工具支持参数限额时，配置其实际整数参数路径，例如 `/limit` 或 `/maxRows`。缺省值在审批前注入工作流与绑定预算的最小值；显式超限值在发布或运行时拒绝，下游调用为零。该路径不能与锁定资源参数重叠。审批展示、动作哈希、每次尝试的实际参数使用同一规则。
- 工具只能由服务端固定限额时，配置 `rowLimit: {"serverMaxRows":10,"attestation":"独立核验记录"}`，验证请求同时提交准确的 serverMaxRows。这个固定上限必须小于等于当前工作流的有效预算；更小预算无法由它保证时拒绝运行。服务端能力需要真实账号或受审查模板证明，不能从 readOnlyHint 推断。
- 没有可执行限额声明的真实生产工具，不能通过验证和发布。旧的非生产适配仍保留返回后检查，但不能把它解释为下游读取硬上限。内置 Mock 明确接收并执行 maxRows；其他 Mock 接口需按自己的契约声明。

修改适配器、凭据、资源或连接配置会使绑定验证失效；重新验证后须发布新工作流版本。发布快照保留完整绑定和适配器配置，已有不可变版本不会被后台改写。真实公司 MCP 的协议、权限和限额仍需经批准现场核验。
