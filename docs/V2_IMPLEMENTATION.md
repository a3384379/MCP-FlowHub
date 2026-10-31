# FlowHub 2.0 实施记录

## 基线与边界

2026-10-31，本机 macOS arm64；checkout 位于当前仓库，起点 main@45eed03ee9f6f513a5c67e854d3d42e16afee636。
`git fetch origin` 后主干没有后续变更，工作区最初干净。开发分支 `feat/flowhub-v2`。
用户提供的设计包原位于 Downloads，仓库缺少 upgrade-v2，因此按入口说明复制至 docs/upgrade-v2/，未覆盖根约束。
默认 Node/npm 为 22.22.0/10.9.4；官方 Node 24.19.0 arm64 包下载到 /tmp/flowhub-v2-runtime 并核对 SHA256，npm 11.9.0 安装于该临时工具目录；没有更改全局运行时。
测试只使用 mkdtemp 隔离库与动态端口；18473/18474 基线未监听。不打开正式数据库，不改 Codex 配置，不 push/merge/Release。

## 范围与顺序

S0 冻结 v1 DDL、顺序迁移、基线与 Windows 失败定位；S1 统一 Authoring 与 v2 DTO；S2 本机发现/目录/导入；S3 固定 MCP 工具与产品级自测；S4 Provider/问答/可靠工具循环；S5 正式 React 联动；S6 全回归/宿主；S7 本机包/恢复/Windows边界。
保留单 daemon、旧七工具兼容、原始业务数据、环境/owner/凭据边界；正式工具集合扩展至 21。不恢复审批或业务自动脱敏。

## S0（已完成本机验证）

修改：导入设计包；更新增量约束；从旧 repository.ts 原样冻结 v1.ts，checksum `39b4d8eab1f40befe28a3c7642a8e6b2b9398e1aa6a7e3895f74d572c4c88784`；迁移注册表验证已知完整前缀并事务升级，启动/备份预检/恢复共用；增加旧库、未来历史、损坏表、失败回滚测试。

当前 Windows CI 实证：run 41160071532（同基线 SHA）Windows 的两项 settings-integration 测试失败，actual 为 `runneradmin` 长目录而 expected 为 `RUNNER~1` 短目录。夹具现在先 realpath；保留路径断言，原生 Windows 修复结果未验证。

命令：`git fetch origin`、`gh run view 41160071532 --repo a3384379/MCP-FlowHub --log-failed` 均 exit 0；项目专用 Node/npm 执行 `npm ci --no-audit --no-fund` exit 0；`npm run check` exit 0（静态设计检查 37 正向/65 负向，其边界不是产品运行验收）。全量 `npm test` 首轮 exit 1：186/191，通过外的 5 项均为 macOS 临时目录符号链接触发安装器检查。规范化测试根目录后复跑 exit 0：191/191（63.2 秒）。随后 build:server + 迁移/runtime 定向 8 项 exit 0，覆盖启动前先校验历史的最后修改。

日志临时位置：/tmp/flowhub-v2-s0-check.log、/tmp/flowhub-v2-s0-test.log、/tmp/flowhub-v2-ci-baseline.log。汇总以实际退出码为准。

未验证：原生 Windows、真实模型、真实 Codex MCP 会话、企业 MCP；没有实际模型调用。

## S1–S7

尚未实施，不计通过。后续每阶段继续补实际修改、命令、退出码、证据和本地提交。

S0 后续修复：macOS 安装器夹具使用 realpath，仍保留拒绝目录链接/路径穿越等负向测试；openStore 在 WAL 设置和 boots 计数写入前校验历史，损坏/未来数据库不产生业务写入。
