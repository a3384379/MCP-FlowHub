# MCP FlowHub

一个本机 MCP 入口，固定七工具，多条可视化受控工作流。Codex 继续分析，Hub 负责确定性执行、固定环境、独立人工审批和证据归档。

当前版本 **1.0.0-rc.1**。已实现管理界面和端到端合成流程。Windows 原生 CI、真实 Codex 和企业只读联调仍需分别验收。

## 启动

Node **24.19.0**、npm **11.9.0**，使用现有 checkout：

    npm ci
    npm run build
    npm start

默认仅监听 127.0.0.1:18473。首次管理页需要数据目录内 admin-setup-token 的一次性设置码，创建至少 12 字符密码；首次设置同时初始化凭据库。重启后需单独解锁。设置码和执行 token 不写日志，不要分享数据目录。

另一个终端：

    npm run mcp

显式数据目录与端口：

    npm start -- --data-dir /tmp/flowhub-dev --port 18474
    npm run mcp -- --data-dir /tmp/flowhub-dev
    node dist/apps/daemon/src/cli.js doctor --data-dir /tmp/flowhub-dev

Linux 默认 $XDG_DATA_HOME/mcp-flowhub（未设时 ~/.local/share/mcp-flowhub），Windows 默认 %LOCALAPPDATA%\MCP-FlowHub。程序和数据分离。POSIX 目录 0700、令牌/数据库 0600；Windows ACL 待批准设备核验。

## 已实现能力

- 六页面 React 管理中心：工作流库、React Flow 画布、MCP 工具库、环境权限、运行证据、接入设置。支持拖拽连线、节点/映射/Schema 编辑、保存/校验/发布。
- 官方 SDK v2：modern 2026-07-28 / legacy 2025-11-25，STDIO 与 Streamable HTTP。唯一 daemon、无第二引擎薄桥；连接目录分页、Schema 指纹/历史、代际缓存和修订失效。
- 受限 DSL：串行/互斥、图/支配/类型/映射校验、不可变发布、默认版本指针、禁用草稿导入、环境/资源/模板锁定。
- 持久化状态机、快照、dispatch intent、CAS/幂等、预算/取消、检查点恢复；不确定结果终态、人工复核新运行。
- 独立管理员、CSRF/Host/Origin、scrypt + AES-GCM、重启锁定/口令轮换、独立宿主范围/撤销。
- 审批绑定具体 snapshotHash/actionHash/参数/有效期。七工具无法批准、解锁或修改连接。
- Agent/宿主 Skill 交接、实际 Markdown/安全 HTML 报告、章节/归属/引用/字节/哈希验证，预声明且明确选择的模板降级。
- SQLite WAL/迁移校验、一致性备份、停止服务恢复、保留期预览清理、先预览再导出的脱敏支持包。
- 两套真实协议合成排查，生产/试运行使用不同哨兵，不连接企业系统，不要求额外模型 API。

真实绑定必须完成获准探测及独立服务端只读权限确认。MOCK_VERIFIED 不授权真实生产执行。

## 验证与离线包

    npm run check
    npm test
    npm run test:ui
    npm run package:local
    npm run test:package
    npm run verify:release

浏览器测试使用系统 Chromium，或 FLOWHUB_CHROMIUM 指定路径；否则使用 npx playwright install chromium 安装官方浏览器。CI Ubuntu 执行浏览器测试；Windows 原生执行协议/引擎和打包测试。

Windows 构建机运行 npm run package:windows。Linux 拒绝伪 Windows 包。候选包含平台 Node、生产依赖/SQLite 原生模块、编译 UI、启动器、SBOM、第三方许可与哈希；目标机无需 npm install。包内 ./flowhub serve 或 flowhub.cmd serve 启动。哈希不是代码签名。

管理页创建一致性备份。恢复必须先停止 daemon：

    node dist/apps/daemon/src/cli.js restore --data-dir <数据目录> --backup <备份文件>

恢复前自动保存旧数据库，不覆盖程序和执行令牌。升级前先备份；禁止把不兼容的新数据库直接交给旧程序。

## 文档与边界

- [宿主接入及 Skill](docs/HOST_INTEGRATION.md)、[设备核验与升级](docs/LOCAL_VALIDATION.md)
- [外部审计 F01–F08 整改](docs/evidence/EXTERNAL-AUDIT-2026-10-30.md)、[结果适配与限额](docs/MCP_RESULT_ADAPTERS.md)、[上一轮修复](docs/evidence/REMEDIATION-2026-10-30.md)、[实施进度](docs/PLAN.md)、[依赖基线](docs/DEPENDENCY_BASELINE.md)
- 用户原始 [方案](docs/01_产品与架构设计.md)、[接口](docs/02_协议接口与数据设计.md)、[100 项验收设计](docs/04_测试验收与云端交付.md)、[交互原型](docs/reference/interaction-prototype.html)

不宣称 100 项验收全过。公司加密兼容、Windows ACL、实际生产/试运行和真实 Codex 需外部记录，未满足前不作生产发布。当前不含旧 HTTP+SSE 自动 OAuth、任意代码节点、并行/循环、多租户和自动更新。没有可信安全重试依据时保守停止，不重复执行结果不明的调用。

用户源码许可证由维护者决定；第三方保留原许可及 SDK Apache-2.0/MIT 过渡说明。

升级前停止 daemon 并保留本机备份。首次解锁会把历史敏感输入转为安全展示副本和独立密文，把含明文认证参数的旧连接加密隔离并停用；原始业务记录不会被静默删除。需要更正连接、显式配置工具适配器与限额、重新验证绑定并发布新版本。旧备份、WAL 和系统历史副本仍按敏感资料管理；这不是磁盘安全擦除。回退旧程序须恢复升级前备份，不支持让旧二进制继续处理新格式记录。

guided 流程从 Web 生成交接指令，由当前受限 Codex 实际启动和继续，Web 负责查看与独立审批。复杂 Schema 仍需 JSON；草稿采用手动保存，工具分组搜索和报告全文一键下载尚未完成。真实 MCP 的服务端权限、限额和企业准入必须独立验收。
