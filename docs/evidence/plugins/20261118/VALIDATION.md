# 本地 Codex 插件交付验证

验证时间：2026-11-17–18（Asia/Shanghai）。平台：macOS 26.6.2、arm64。Node 24.19.0、npm 11.9.0。实际 Codex：0.169.0-alpha.11.1。

## 基线与修改

在现有 checkout 中，从已合并的 `origin/main` / `5867c35a95473fa6122bbd3d8d00f496c6fb2654` 建立 `codex/flowhub-plugin`。保留原有 `.DS_Store` 和未跟踪的 `docs/evidence/v2/chat-audit-20261031/` 八个文件。没有操作正式 SQLite、Vault、用户 Codex 配置或登录态；所有新运行与身份来自临时隔离数据。

- `plugins/flowhub/`：portable manifest、兼容 manifest、本地 marketplace、SVG 图标、连接/编排/自测三个中文 Skill。
- `scripts/package-plugin.mjs`：在原离线包内生成平台专用 MCP 配置和启动入口，不另建产品。使用包内 Node 与 `${PLUGIN_ROOT}` 参数；portable command 使用合法的 `./runtime/node[.exe]`。
- `scripts/flowhub-plugin.mjs`：外部连接引用、显式启动、诊断和薄桥入口。配置只保存路径，写入使用私有权限及原子替换；失效或损坏配置不降级为个人身份。
- `apps/daemon/src/cli.ts`：修复 doctor 忽略 `--token-file` 的问题，诊断范围与真实 MCP 身份一致。
- 原离线构建、source snapshot 和 release verifier 同步包含插件、中文帮助、隐藏兼容 manifest 和源码一致性验证。安装不运行 hooks，不隐式启动后台；固定 21/7 工具与原工作流服务共用。
- 锁文件中仅更新 Hono 两个传递依赖的补丁版本，生产依赖审计归零。见 `docs/DEPENDENCY_BASELINE.md`。

## 命令与实测结果

| 命令或检查 | 实测结果 | 证据 |
| --- | --- | --- |
| `npm ci`（固定 Node/npm） | 通过；更新锁文件后审计 0 漏洞 | `install.txt` |
| `npm run check` | 通过；静态正例 37、反例 65，均通过 | `check.txt` |
| `npm test` | 543/543 通过，无跳过 | `tests.txt` |
| 插件/源码交付定向回归 | 16/16 通过；包括符号链接父路径、配置损坏、身份保留、版本不一致、源码白名单及篡改拒绝 | `targeted.txt` |
| skill-creator `quick_validate.py` ×3 | 三个 Skill 均通过；Python 依赖在仓库外临时 venv | `skills.txt` |
| `npm audit --omit=dev --audit-level=moderate` | 0 vulnerabilities | `audit.txt` |
| `npm run package:plugin` | 构建 darwin-arm64 离线候选、原生 SQLite、源码、SBOM、运行时和完整性清单 | `artifacts/latest-package.json`（本地产物） |
| `npm run test:package` | 从归档解压到含中文/空格的新路径；现代与 legacy MCP、21/7 身份、真实草稿、合成 Mock、篡改拒绝均通过 | `package-smoke.txt`、`package-smoke.json` |
| `npm run test:plugin` | 从归档另行解压；真实 Codex marketplace 添加/安装/加载/卸载通过 | `plugin-smoke.txt`、`plugin-smoke.json` |

实际顺序：固定运行时安装 → 检查与完整测试 → 插件构建 → 定向回归 → 归档解压测试 → 真实 Codex 插件测试 → 审计修复及重验 → 本地提交。目录中的 smoke 回执记录预提交候选的归档 SHA；最终程序包的 Git SHA、dirty 状态和 sourceTreeSha256 见包内 `build-info.json`，最终归档身份见本地 `artifacts/latest-package.json` 与 `.sha256` 文件。保留的用户未跟踪文件会如实影响 dirty 标记。

真实 Codex 验证没有手写替代 MCP 配置，使用实际 `plugin marketplace add`、`plugin add` 和 App Server。个人身份加载 21 工具并成功 `workflow_draft_get` 读取本轮创建的隔离草稿；受限身份加载 7 工具并成功 `workflow_search`。两次均发现：

- `flowhub:flowhub-setup`
- `flowhub:flowhub-author`
- `flowhub:flowhub-test-report`

配置写在隔离 Codex Home 的 `flowhub/connection.json`。后台未启动时，MCP 失败且不创建数据目录；doctor 与桥均维持受限身份；失效令牌连接失败且不切换个人身份。插件移除后，隔离连接引用、后台健康状态与数据仍保留。模型调用次数为 0，未复制任何个人 Key、OAuth 或企业凭据。

## 审计发现与修复

1. 初版入口使用逻辑路径判断是否执行，经符号链接父目录运行会静默跳过。改为 realpath 判断，并加入独立进程回归。
2. 初版 portable command 使用 `${PLUGIN_ROOT}/runtime/node`，当前 Codex 拒绝此 command 形态。改为包内 `./` 路径，参数与 cwd 继续用内置 placeholder；通过实际宿主安装和调用重验。
3. 既有 doctor 未传递解析到的 token-file，可能让受限身份诊断成个人范围。已修复，并通过真实 7 工具目录重验。
4. 兼容 MCP overlay 显式转发 `CODEX_HOME`、`XDG_DATA_HOME`、`LOCALAPPDATA` 路径变量，避免宿主过滤环境后连接到其他实例；不转发凭据变量。
5. macOS Finder 会在可见 staging 目录额外写 `.DS_Store`，完整性检查正确拒绝未列明文件。插件独立冒烟改为校验归档 SHA 后在全新临时目录解压，验证用户实际收到的归档；没有放宽清单规则或删除用户文件。
6. 生产依赖公告命中 Hono 两个传递依赖；在 SDK 兼容范围内升级至 hono 4.13.19、@hono/node-server 2.1.9，完整测试、协议和打包重验通过。

## 未验证项

- Windows、Linux、Intel Mac 的原生插件构建与宿主安装；配置生成测试不能代替对应系统验收。Windows 继续由原生 Windows 门禁验证。
- 第二台实体电脑首次安装、系统下载隔离/Gatekeeper、签名和公证；本轮验证的是同一 Mac 上独立路径、缓存和 Codex Home 的迁移。
- 桌面插件卡片的人工视觉验收、自然语言模型选择技能与端到端生成效果；本轮验证实际 App Server、技能目录与 MCP 操作，没有发起模型轮次。
- 实际企业服务、真实只读权限、公司设备、真实模型计费和效果。Mock/合成验证不代表这些环境可用。
- 官方目录提交或发布。本轮仅制作本地包并本地提交，没有 push、merge 或 Release，也没有安装到用户日常 Codex Home。

官方结构参考：[插件包格式](https://developers.openai.com/plugins/build/plugins)、[本地 MCP 包](https://developers.openai.com/plugins/deploy/desktop-only)。实际兼容性以上述宿主测试为准。
