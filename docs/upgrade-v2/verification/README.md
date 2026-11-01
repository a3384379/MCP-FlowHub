# 本设计包验证范围

- `validate_design.py`：关键JSON Schema/正负样例、21工具集合、104验收条目、30自然语言场景、Markdown代码围栏和离线资源检查。需要Python和requirements.txt中的jsonschema；不访问网络/MCP，不执行FlowHub产品。
- `design-check-result.json`：上述自检的真实执行结果。
- `ui-prototype-check-result.json`：离线HTML的浏览器模拟交互结果。验证的是本包原型，不是仓库React产品。

运行：`python verification/validate_design.py`。缺少依赖时按本机允许方式安装requirements.txt；该依赖不是FlowHub运行依赖。

本沙箱浏览器策略拒绝直接file://导航，因此使用Playwright set_content渲染相同HTML进行检查，没有修改浏览器或系统策略。原型无外部脚本、样式、网络请求；实际双击打开是否被公司策略允许，需在本机确认。

本包没有执行真实Codex发现、模型Key调用、企业MCP查询或Windows产品安装；这些仍需开发后验收。
