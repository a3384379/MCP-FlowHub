# 2.0 验收

设计矩阵见 upgrade-v2/docs/04_测试与验收方案.md。设计包自检不计产品验收。
所有尚未关联实际产品测试的项目均为未验证；不得根据实现说明推定通过。

S0：check exit 0；全量测试 191/191 exit 0；最终迁移/runtime 定向 8/8 exit 0。Windows CI 已读取，修复夹具后尚无原生重跑。
S1：统一编排/迁移/恢复/发布CAS 16/16 exit 0，日志 S1-tests.txt；S2：发现合成测试 4/4，真实本机 metadata PARTIAL，详见 S2-local.txt；S3：SDK闭环通过，后台全量 200/200 exit 0，旧身份7工具/默认21工具均验证；S4：助手/双协议/中文问答合成 12/12，SSE生命周期3/3；真实模型0调用，L4未验证。S5：后台定向19/19、全量浏览器24/24、最终定向浏览器3/3，均 exit 0；后续阶段结果见下。
真实 Provider 的 30 场景评测：未执行，无模型调用。

S6：check exit 0，完整后台220/220（含build）、浏览器24/24，新增边界16/16。真实本机Codex App Server（临时Home、无OAuth）经MCP完成21工具发现/编排/自测/报告，模型调用0。完整104项证据矩阵：`evidence/v2/acceptance-results.json`，S6为64 PASS / 30 PARTIAL / 10 UNVERIFIED；PARTIAL不计通过。30条真实模型场景逐项保留在`nl-evaluation-results.json`，均UNVERIFIED。

S7最终代码：check/build exit 0；后台225/225（78.5秒）、浏览器24/24（25.5秒），真实Codex最小闭环再次通过。实际旧程序45eed03生成v1草稿/不可变发布/运行/报告/备份，升级v2后所有旧业务行相等；停机恢复并重启旧程序后hash与报告字节相等。缺新表备份被拒绝，运行中恢复被拒绝。

macOS arm64离线候选2.0.0-alpha.1：package:local / test:package / verify:release均exit 0；包内Node独立启动、中文帮助、真实持久化编排、modern/legacy两种协议、个人21工具/旧身份7工具均通过。新增助手模块被篡改后完整性检查明确失败。首次包测试发现CLI真实路径入口和薄桥目录权限问题，均已修复并补回归；没有删测试绕过。最终本地提交后再次生成干净源码候选，最终路径与hash从artifacts/latest-package.json读取。

最终104项矩阵为 **72 PASS / 26 PARTIAL / 6 UNVERIFIED**。PASS只对条目列明的合成或本机证据有效，不代表真实模型/企业/Windows验收；PARTIAL仍不可计为通过。30条真实目标模型评测全部UNVERIFIED，0次真实Provider调用。Windows原生构建/安装器/公司策略、真实企业MCP权限、现有Desktop会话授权仍未验证。没有运行会覆盖日常安装的安装器smoke。
