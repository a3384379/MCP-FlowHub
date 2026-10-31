# 2.0 验收

设计矩阵见 upgrade-v2/docs/04_测试与验收方案.md。设计包自检不计产品验收。
所有尚未关联实际产品测试的项目均为未验证；不得根据实现说明推定通过。

S0：check exit 0；全量测试 191/191 exit 0；最终迁移/runtime 定向 8/8 exit 0。Windows CI 已读取，修复夹具后尚无原生重跑。
S1：统一编排/迁移/恢复/发布CAS 16/16 exit 0，日志 S1-tests.txt；S2：发现合成测试 4/4，真实本机 metadata PARTIAL，详见 S2-local.txt；S3：SDK闭环通过，后台全量 200/200 exit 0，旧身份7工具/默认21工具均验证；S4–S7 未执行。
真实 Provider 的 30 场景评测：未执行，无模型调用。
