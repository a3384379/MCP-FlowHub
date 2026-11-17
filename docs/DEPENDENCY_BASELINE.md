# S0 依赖基线

实际安装验证：2026-10-29，Linux x64。直接依赖精确版本和传递依赖见 package-lock.json；npm ci 保持 integrity/TLS 校验。

| 依赖 | 版本 | 用途 | 包许可摘要 |
|---|---|---|---|
| Node.js | 24.19.0 | daemon、子进程、包内运行时 | MIT 及附带组件许可 |
| npm | 11.9.0 | 安装/SBOM，目标机不需要 | Artistic-2.0 |
| @modelcontextprotocol/server | 2.4.0 | 七工具、现代/legacy serving | Apache-2.0；LICENSE 含 MIT 过渡说明 |
| @modelcontextprotocol/client | 2.4.0 | 下游和薄桥客户端 | 同上 |
| @modelcontextprotocol/node | 2.1.2 | 官方 Node HTTP adapter | 保留实际 LICENSE |
| Fastify | 5.12.7 | 路由/请求限制 | MIT |
| AJV | 8.20.0 | Draft 2020-12 验证 | MIT |
| ajv-formats | 3.0.1 | 设计 Schema 格式 | MIT |
| better-sqlite3 | 13.0.3 | 原生 SQLite/WAL | MIT |
| TypeScript | 7.0.2 | strict 编译 | Apache-2.0 |
| @types/node | 24.10.1 | Node 类型 | MIT |
| @types/better-sqlite3 | 7.6.13 | SQLite 类型 | MIT |

**许可**：表为元数据摘要，不替代文件级审查。SDK LICENSE 含 Apache-2.0/MIT 迁移说明，不统一改标。离线包保留依赖原始 LICENSE/NOTICE，生成完整 THIRD_PARTY_NOTICES.json、SBOM.cdx.json。Node 24.19.0 LICENSE 从 nodejs/node 官方对应标签获取，保存在 docs/third-party，包含其他运行时组件许可。用户源码许可证待维护者决定。

**协议实测**：Linux modern 2026-07-28 与 legacy 2025-11-25，均覆盖 HTTP/STDIO。SDK 默认 legacy；测试显式 pin modern，分别记录 era/版本。不声明其他旧协议、stateful legacy HTTP+SSE、真实 Codex 或企业兼容。

**审计**：初始 Fastify 5.7.1/AJV 8.17.1 命中已知漏洞，已升级到上表修复版本，未使用 audit fix --force。最终审计结果见 S0 证据。没有关闭证书/签名/哈希校验。

**Windows**：CI 固定 Node/npm，原生安装、同套测试、含 Node 的 ZIP、解压冒烟。尚无本次 Windows CI 运行证据，不能据 Linux 成功推断 Windows 兼容。

## RC 新增实际锁定依赖

| 依赖 | 版本 | 用途 | 许可摘要 |
|---|---|---|---|
| React / React DOM | 19.3.1 | 正式管理 UI | MIT |
| @xyflow/react | 12.12.0 | 图编辑、拖拽、连线、缩放/小地图 | MIT |
| Vite | 8.3.5 | 浏览器构建，开发依赖 | MIT |
| @playwright/test | 1.64.1 | 实际浏览器 E2E | Apache-2.0 |
| @types/react | 19.2.14 | React 类型 | MIT |
| @types/react-dom | 19.2.3 | React DOM 类型 | MIT |
| Prettier | 3.6.2 | 源码格式化 | MIT |

版本、传递依赖和 integrity 以当前 package-lock.json 为准。RC 使用 Node 内置测试框架、Playwright 和系统 Chromium 进行云端测试。实际生产依赖审计、离线包和浏览器结果见 RC 验收记录；早期 S0 记录保留为历史证据，不覆盖本轮结果。

## Windows 安装器构建工具链

NSIS 3.11，官方归档 `https://prdownloads.sourceforge.net/nsis/nsis-3.11.zip`，SHA256 `c7d27f780ddb6cffb4730138cd1591e841f4b7edb155856901cdf5f214394fa1`。完整固定配置见 `installer/windows/toolchain.json`；构建器验证归档后在临时目录使用其编译器，不能替换为未经核验的系统工具。

官方 `COPYING` 列明 zlib/libpng、bzip2、Common Public License 1.0（LZMA 模块）。安装器保留 `NSIS-COPYING.txt` 和 `NSIS-NOTICE.txt`；不把工具链整体改称 MIT。它是安装包构建工具，未新增应用 npm 运行时依赖。Windows 原生 CI 和安装冒烟结果以本次实际运行记录为准，Linux 辅助测试不算 Windows 通过。

## 2.0 S2 增量

smol-toml 1.4.2（BSD-3-Clause），真实 TOML 解析及静态配置回退；固定版本与 integrity 已写入 lockfile。未升级其他依赖；Codex App Server 请求类型来自本机 0.164.0-alpha.11.1 的 generate-ts，生成后仅将本地模块引用调整为 NodeNext 的 .js 后缀。

## 2026-10-31 发现页增量

- `yaml 2.9.1`（ISC），用于 Skill frontmatter 和 `agents/openai.yaml` 结构化依赖解析；固定版本及 integrity 已写入 lockfile。只解析数据，禁止别名扩展；不加载自定义执行标签，不执行技能指令或依赖中的 URL/命令。
- `smol-toml` 从 1.4.2 升至 1.9.1（BSD-3-Clause），修复本次 `npm audit` 报告的畸形/大量注释 TOML 导致拒绝服务等漏洞。仅升级解析库，没有运行 `audit fix --force`。安装后审计结果：0 vulnerabilities；后续证据见 `docs/evidence/v2/discovery/`。
- Node 24.19.0 / npm 11.9.0 保持不变。实际平台为 macOS arm64；Windows 原生验证仍单独记录。

## 2026-11-17 本地插件包

- 插件入口、打包与验证使用 Node 内置模块，没有新增直接依赖；Node 24.19.0 / npm 11.9.0、官方 MCP SDK 版本保持不变。
- 本轮 `npm audit --omit=dev` 发现 `hono 4.13.14` 和 `@hono/node-server 2.1.5` 的中危公告。将这两个传递依赖在 SDK 现有兼容范围内分别更新至 **4.13.19**、**2.1.9**；只更新对应 lockfile 的版本、resolved 与 integrity，没有使用 force 或放宽 TLS 校验。
- 用更新后的 `npm ci`、完整检查和测试、生产依赖审计、离线包与真实本地 Codex 插件安装验证，结果见插件交付证据。Python Skill 校验依赖安装在仓库外临时虚拟环境，不加入产品依赖。
