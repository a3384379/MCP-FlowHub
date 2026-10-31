# 2.0 验收

设计矩阵见 upgrade-v2/docs/04_测试与验收方案.md。设计包自检不计产品验收。
所有尚未关联实际产品测试的项目均为未验证；不得根据实现说明推定通过。

S0：check exit 0；全量测试 191/191 exit 0；最终迁移/runtime 定向 8/8 exit 0。Windows CI 已读取，修复夹具后尚无原生重跑。
S1：统一编排/迁移/恢复/发布CAS 16/16 exit 0，日志 S1-tests.txt；S2：发现合成测试 4/4，真实本机 metadata PARTIAL，详见 S2-local.txt；S3：SDK闭环通过，后台全量 200/200 exit 0，旧身份7工具/默认21工具均验证；S4：助手/双协议/中文问答合成 12/12，SSE生命周期3/3；真实模型0调用，L4未验证。S5：后台定向19/19、全量浏览器24/24、最终定向浏览器3/3，均 exit 0；S6–S7 未执行。
真实 Provider 的 30 场景评测：未执行，无模型调用。

S6：check exit 0，完整后台220/220（含build）、浏览器24/24，新增边界16/16。真实本机Codex App Server（临时Home、无OAuth）经MCP完成21工具发现/编排/自测/报告，模型调用0。完整104项证据矩阵：`evidence/v2/acceptance-results.json`，S6为64 PASS / 30 PARTIAL / 10 UNVERIFIED；PARTIAL不计通过。30条真实模型场景逐项保留在`nl-evaluation-results.json`，均UNVERIFIED。
