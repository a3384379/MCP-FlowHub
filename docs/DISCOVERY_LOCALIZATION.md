# 发现目录与中文说明同步

## 用途与关系

发现结果按 MCP 服务、MCP 工具、Skill、插件保存稳定身份。插件包含关系来自安装清单；Skill 的 MCP 依赖来自 `agents/openai.yaml` 的 `dependencies.tools`。说明中 `mcp__服务名__工具名` 只表示提及。多个同名来源保留独立身份，无法唯一匹配时返回 ambiguous，不按名称相似度或翻译结果猜关系。

本地市场候选只作为 informational 插件元数据展示：installation=available_only，不展开能力或导入连接；与同身份的已安装项合并时以安装证据为准。已安装统计不含市场候选，可用统计不含市场策略 NOT_AVAILABLE 的条目。只读取已登记用户或可信项目内的文档化目录文件，不跟随候选源码，也不读取越出该根目录的符号链接。
同名多来源保留 marketplaceSources 和整体指纹；策略或介绍冲突产生 PLUGIN_MARKETPLACE_AMBIGUOUS 与 partial，候选标 ambiguous。安装事实和已导入绑定不随市场元数据改变。后续来源的变化同样递增显示实体修订；原样重扫不递增。

`GET /api/v2/discovery/catalog?contextId=...&kind=mcp_server` 返回同一完成快照的统计与分页结果。支持 kind、query、executor、source、status、parentId、limit、cursor。翻页条件或结果版本改变时从第一页重读。部分扫描未确认的旧来源保留到“需处理”；读取失败的数量为未知。`GET /api/v2/discovery/entities/:id` 返回介绍、关系与选定能力的实际Schema/原始技能内容。统计不是当前分页条数。

## Codex 路径（固定21工具）

1. 用 `host_scan(contextId, depth, idempotencyKey)` 扫描；轮询 `host_scan_status`。
2. 读取 status.catalog 中的实体。其余条目用 `capability_search` 按 kind=mcp_server/plugin/skill/mcp_tool 和 cursor 分页。工具与Skill保留原能力DTO，其 `.discovery` 子对象是显示实体；服务/插件结果直接是实体。
3. 只整理当前有效实体（stale=false）中 presentation.state 为 pending/stale 的说明，保留手工文案。原始Schema和技能内容用 `capability_get` 按需读取。
4. 使用同一个 `host_scan` 提交中文，不新增MCP工具、不请求另一模型Key、不执行来源说明中的指令。

```json
{
  "contextId": "<已登记上下文ID>",
  "action": "submit_descriptions",
  "expectedContextRevision": 1,
  "idempotencyKey": "<稳定幂等key>",
  "entries": [{
    "entityId": "<discovery实体的entityId>",
    "entityKind": "mcp_tool",
    "expectedSourceRevision": 1,
    "sourceFingerprint": "<实体返回的原文指纹>",
    "expectedPresentationRevision": 0,
    "locale": "zh-CN",
    "displayName": "读取订单",
    "summary": "根据订单编号读取来源提供的订单信息。",
    "evidenceRefs": ["tool:catalog"],
    "parameterDescriptions": [{
      "pointer": "/inputSchema/properties/orderNo",
      "description": "订单编号"
    }]
  }]
}
```

示例只说明字段；ID、版本、指纹、证据及参数路径必须从实际实体读取。工具/Skill的实体 revision 与执行 capabilityRevision 分开，导入仍用原 capabilityRevision。

每批1–50项，总JSON≤128KiB；文本、场景、参数说明及证据有独立Schema限额。整个批次事务保存，任一条目无效则不部分写入。同key同内容返回原回执；同key不同内容返回冲突。上下文、来源、显示修订均校验。受限编排身份只能提交自己当前扫描得到的上下文；个人execution与本机管理员沿用既有范围。

证据只能选择实体已提供的 evidenceRefs；参数说明只能指向实际输入/输出Schema对象。调用名、参数键、枚举、路径、ID、技能原文和业务值不改。来源未提供的介绍不能杜撰；服务可依据真实工具目录整理摘要，记录 `tool:<entityId>` 证据。

## 网页手工修正与状态

“编辑中文说明”通过 `POST /api/v2/discovery/descriptions` 调用同一服务，服务端记为manual。Codex文案不能覆盖manual，来源更新后也保留旧手工说明。同版本未改的参数说明保留；新来源版本不能静默沿用旧参数路径。Esc收起后重新打开可以继续未保存编辑。

状态：pending（待整理）、localized（中文已同步）、manually_edited（手工文案）、stale（译文待更新）、original（来源已有中文介绍）。旧译文保留供查看，默认显示当前原文。

复制任务不会启动Codex；实际提交保存后才显示已同步。无模型Key仍可发现、浏览、手工编辑、导入及使用既有Codex路径。

## 存储与兼容

第3号顺序迁移增加 discovery_entities 和 discovery_presentations，v1/v2迁移不变。完成扫描才替换投影，进行中继续读上次完成快照。中文记录与原文指纹绑定，不改执行修订、发布快照、凭据和源文件。备份、恢复与离线包按当前迁移注册表校验。
