# Launcher / viewport 独立 max 复审

L01、L02：通过。此结论限定于入口、浮窗视口和关联交互。

从当前共享源码复制含viewport.ts的前端到本临时目录，独立Vite构建；临时daemon读取该目录中的新web-dist。页面实际请求index-BRKGqjMJ.js，HTTP资产SHA与独立新构建逐字节一致。复审结束时所有apps/web快照文件与共享源码哈希仍相同；期间assistant-intent.ts由其他修复任务继续变更，不在本轮视口结论范围。

9场景×左右两边，18/18几何、命中检测和真实发送点击均通过；18次点击完成18个合成任务，请求数量恰18。覆盖原844×390单行、390×350十行、844×300，以及320×300、手机/桌面2×、手机/桌面3×、横屏2×。每例收起重开后未发送输入及session均保留。

原12项交互对照12/12通过：鼠标/触摸拖动、吸附、贴边、取消、键盘移动/打开、内部路由、历史会话的未发送草稿、旧/assistant复用session、刷新偏好与短屏入口限位。移动/切页本身模型请求0。

已打开窗口后，实际CDP手势产生visualViewport offsetLeft=40、offsetTop=40、width=195、height=422。面板及输入/发送/收起完整在该可见矩形内；直接CDP触摸可见坐标174.5,44.5，实际click target为“收起聊天窗口”（client215,85），关闭成功；重开后输入/session保留。证据nonzero-pan-final.json与PNG。

保留两次工具失败原文：短横屏CDP滚动位置越界；Playwright在非零pan时的scrollIntoView触发偏移变化导致locator点击超时。后二者没有伪报通过；实际非零偏移已以直接物理触摸补证。累计34次合成Provider HTTP调用（含首次工具中断前16次），付费模型及企业调用均0。

未执行实体手机、真实软键盘、屏幕阅读器、Windows、WebKit/Firefox及全量check/test/UI；不覆盖其他助手意图/执行授权问题。

清理：原PID96354在开始复审前已退出。本轮专用browser launcher-max已关闭；确认新PID2233命令精确匹配本fixture后发送SIGTERM。未操作18473或18479。只保留/tmp合成证据和数据库，仓库只读。
