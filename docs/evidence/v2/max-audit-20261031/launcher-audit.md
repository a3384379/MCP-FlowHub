# Launcher max 只读审计（HEAD 61e19ee）

确认 2 项 P2。未发现本范围 P1。仓库源文件哈希保持不变；仅使用 /tmp 独立数据、进程和新建的 headless Chromium。新构建源码副本的 JS/CSS 与现有 web-dist 逐字节一致。

## LAUNCHER-MAX-01 P2：短视口裁掉发送区

定位：`apps/web/src/features/assistant/assistant.css:301-305`（关联125-140、577-580、733-744；FloatingAssistant.tsx:117-123）。

实际 Chromium：844×390，单行输入，panel bottom=298；send y=294..323，只有4px露出，中心命中检测为false。390×350输入十行后，textarea y=232..372，send y=377..406，panel bottom=350，按钮全部在隐藏区外。不是缺Key造成的布局：使用已配置合成profile。源于消息区min-height80、不能缩的composer、固定header/context和桌面bottom92的组合超出panel高度，再被overflow:hidden裁掉。

最小修复：短视口重新分配可见高度；消息区min-height0，仅消息区滚动；textarea上限受剩余高度限制，保证标题、输入、发送同时可见。回归应验证实际controls矩形和命中/点击，而非只量panel边缘。证据：geometry.json、final-844x390.png、final-390x350-multiline.png。

## LAUNCHER-MAX-02 P2：pinch后入口可见，面板在可视区外

定位：`apps/web/src/features/assistant/FloatingAssistant.tsx:143-154`（关联assistant.css:125-130、733-744）。

实际CDP pageScaleFactor=2：layout1440×900，visual720×450，入口x654..708仍可见；panel x996..1416、y156..808，完全跑到右侧屏幕外。layout390×844时，visual195×422，panel仍宽390；send x333、close x339，在可见宽度195以外。height/top变量更新已等候完成，不是resize未到达的竞态。

最小修复：面板与入口共用visualViewport的width/height/offsetLeft/offsetTop，对实际可视矩形做尺寸与坐标约束。不要以禁止放大作为修复。回归使用真实CDP pageScaleFactor2/3，补左右与平移场景。证据：geometry.json、final-pinch-1440x900.png、final-pinch-390x844.png。

## 正常路径及边界

12项对照均实际通过（见interactions.json）：鼠标吸附、22px贴边、CDP触摸吸附、touchCancel恢复、键盘上下/切边/Esc/Enter、不误开窗、各会话未发送草稿、内部切页、旧/assistant重定向并复用选中会话、刷新布局偏好、320×300关闭入口限位；模型请求总数0。

未执行：实体手机/真实软键盘、屏幕阅读器、Windows、WebKit/Firefox、实际touch pinch和平移offset、全量check/test/UI、真实模型/宿主/企业MCP。未把既有50项绿灯当作本轮正确性证据。

## 临时运行环境

证据根：`/tmp/flowhub-launcher-max-ap80wsi9/`。完整条目、精确路径、修复和回归建议见findings.json。fixture PID96354，URL http://127.0.0.1:65110；本轮专用CLI会话launcher-max，浏览器pid96382。留待修复代理复验。

清理：只执行 `bash /Users/sqz/.codex/skills/playwright/scripts/playwright_cli.sh --session launcher-max close`（使用记录的Node/npm PATH），再确认PID96354仍为本fixture后 `kill -TERM 96354`。不使用close-all/kill-all，不访问18473，不删除正式数据。临时合成库仍保留在此目录。
