# 运行 Schema 的正则限制

工作流输入、Agent/报告输出及下游发现的工具输入/输出 Schema 使用同一受限正则规则，发布/目录发现时拒绝不受支持的 `pattern`，下游派发前再校验实时 Schema。错误为 `SCHEMA_INVALID`；不会先执行危险正则再依赖异步超时中断它。`patternProperties` 的键也按相同规则检查。

三条路径共用按 JSON Schema 位置遍历的检查器：`properties`、`patternProperties`、`$defs`、`definitions`、`dependentSchemas` 等字典只遍历其值；`allOf`、`anyOf`、`oneOf`、`prefixItems` 遍历 Schema 数组；`items`、`additionalProperties`、`contains`、`propertyNames`、条件等只在 Schema 子节点继续检查。业务字段可以合法命名为 `pattern`、`$ref`、`format` 或 `const`，字典容器本身不会被误当成 Schema。`const`、`enum`、`examples`、`default` 和自定义注解中的对象是惰性 JSON 数据，其中同名键不会被编译为正则或解析为引用；实际 Schema 位置的危险正则、远程或动态引用仍会被拒绝。

资源预算对整个 Schema JSON 计数，包括惰性数据：单份最多 128 KiB、2048 个 JSON 值、嵌套深度 24；工作流输入和 Agent 输出沿用更严格的深度 15。超过任一预算返回 `SCHEMA_LIMIT`，不会因为数据无需执行而跳过大小或结构限制。

支持字面字符、字符类、`.`、边界锚点及基本字符转义（例如 `\d`、`\w`、`\s` 和转义标点）。不支持分组、alternation、回溯引用、lookaround、Unicode property 转义和嵌套字符类。模式最多 512 个字符。

出现任何重复量词时必须以 `^` 开始、以未转义的 `$` 结束；整个模式最多一个可变重复（`*`、`+`、`?`、`{m,n}` 或 `{m,}`）。可以包含多个固定次数 `{n}`，单个有限次数及固定次数之和均不超过 4096。不支持 lazy 或叠加量词。这样同时排除量化分组、多个相邻可变重复，以及未锚定重复引起的逐起点搜索。

例如 `^DEMO-[A-Z0-9-]+$`、`^ORDER-[0-9]{4}-[A-Z]{2}$`、`^demo-` 可使用；`^(a|aa)+$`、`a*a*a*b`、`^a+a+$` 和 `a+b` 会被拒绝。已有复杂 Schema 需改成受限模式、标准 `format` 或经过审查的适配器；不保证任意第三方 JSON Schema 可直接接入。此限制不代表企业端点、权限或数据正确性已经验证。
