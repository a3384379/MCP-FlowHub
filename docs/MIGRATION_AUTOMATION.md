# 旧工作流升级指南

本次取消工作流人工审批并保留完整业务内容。升级不删除数据库或用户配置，不改写旧发布快照。

1. 升级前在旧版管理页创建一致性备份，保留数据目录和备份。恢复先停止 daemon，使用 `flowhub restore --data-dir <目录> --backup <备份路径>`。
2. 新版 daemon 遇到非终态旧审批运行，会在数据目录 backups 创建 `pre-legacy-retirement-*.sqlite`。备份失败则启动失败，不停止旧运行。备份成功后，尚未派发的运行转 CANCELLED；已有 dispatch 的转 OUTCOME_UNKNOWN，禁止自动重放。原因 LEGACY_WORKFLOW_RETIRED，原快照、结果、报告、历史记录保留。
3. 登录管理页，在旧草稿卡片选择“迁移旧流程副本”。转换唯一 next 出口的旧节点并重连前后节点，新建未发布工作流副本。迁移前再生成 `pre-workflow-migration-*.sqlite`。原草稿与版本不覆盖，目标 ID 已存在会拒绝。
4. API 可列出受影响范围：`GET /api/v1/legacy-workflows`。复制旧发布版本：`POST /api/v1/workflows/<原ID>/migrate-legacy`，正文 `{ "targetId": "new-workflow-id", "expectedRevision": 1, "sourceVersion": "1.0.0" }`。省略 sourceVersion 取原草稿。
5. 如果旧节点有多个出口、循环，或其他节点依赖其决定输出，返回 MIGRATION_MANUAL_REQUIRED。手动复制并调整业务映射；系统不会猜测通过/拒绝分支。
6. 检查副本的环境和工具绑定，校验后明确发布。新工作流默认指针不会自动切换，受限宿主白名单也不会自动扩权；按需要登记新工作流 ID。

旧审批表只读留存，按现有生命周期清理；没有新增决定 API。旧发布版本尝试新启动会因不支持的节点而拒绝，应使用迁移副本。

新业务输出直接保存原值。旧 operationalOutputs 密文按原 AAD 解密，支持口令轮换、恢复、映射和读取；锁定时原值不可用。过去已脱敏且未保存原值的产物无法无损还原，系统不会伪造历史内容。

原始结果默认保留 7 天，输入与元数据 30 天。现有备份含完整敏感状态，保持本机保存；已有备份不由运行结果清理任务改写。
