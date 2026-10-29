# 实施进度

用户明确要求继续直到所有内容开发完成，取代上一轮仅 S0 的代码范围限制。Windows/公司门禁作为外部验收保留，不阻塞云端代码实现。

| 阶段 | 已落地 | 边界 |
|---|---|---|
| S0 | daemon、薄桥、七工具、SDK、SQLite、Mock、打包 | 历史结果见 S0 证据 |
| S1 | 连接分页、Schema/hash/历史、代际缓存/TTL/失效、凭据库、管理与宿主身份、绑定验证 | 实际只读权限需真实探测及独立确认 |
| S2 | Schema/图/支配/映射/安全校验、发布快照、默认版本、串行互斥、intent、CAS/幂等/预算/取消/恢复 | 不宣称跨系统 exactly-once |
| S3 | 六真实页面、React Flow、映射控件、配置/发布/审批/运行/证据 | 浏览器 E2E 与截图单列，非完整可访问性认证 |
| S4 | 加密检查点、结构化宿主回传、Markdown/HTML、章节/引用/存储分级、模板降级 | 模拟宿主双环境闭环已测；真实 Codex/私有 Skill 待本机核验 |
| S5 | 双平台 CI、原生离线候选、SBOM/许可/哈希、解压冒烟、备份/恢复、支持包、保留期清理 | Linux 实测；Windows/公司/正式签名发布外部验收 |

采用 Node 24.19.0、npm 11.9.0、官方 server/client SDK 2.4.0 + Node adapter 2.1.2、strict TypeScript、React/Vite/React Flow、Node test runner/Playwright。一个编译工程按 apps/packages 分层。

保留原始 docs/01–07 和 contracts/examples；文档内提示词不自动授予发布或公司接入权限。首次 seed 以真实 Mock tools/list 指纹替换内存示例 placeholder，不改样例源文件。发布冻结绑定和工具摘要，实时撤销优先。

持久化实现采用 SQLite 带 revision 的 JSON 领域表及独立命令、事件、迁移表，替代设计的初拟逐字段拆分；保持事务/CAS/唯一幂等键、不可变发布入口和一致性备份。

不自动推送、合并、正式发布；不访问企业系统或读取私有宿主 Skill。详细实际结果和未验证项见 docs/evidence/RC-2026-10-29.md。
