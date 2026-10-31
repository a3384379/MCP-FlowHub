import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";
import { activeTask, type Data } from "./useConversation";
import { modelErrorHint } from "../../../../../packages/contracts/src/model-services";

const statusLabel: Record<string, string> = {
  GENERATING: "正在回复",
  CALLING_TOOL: "正在调用工具",
  COMPLETED: "已完成",
  FAILED: "回复失败",
  CANCELLED: "已停止",
  INTERRUPTED: "服务重启，回复已中断",
};
const toolLabel: Record<string, string> = {
  capability_search: "查询能力目录",
  capability_get: "读取工具定义",
  project_help_search: "检索项目资料",
  workflow_draft_get: "读取当前流程",
  workflow_draft_create: "创建流程",
  workflow_draft_patch: "修改草稿",
  workflow_draft_validate: "校验流程",
  workflow_draft_publish: "发布流程",
  workflow_test_generate: "生成测试用例",
  workflow_test_run: "运行隔离自测",
  workflow_start: "启动流程",
  host_scan: "扫描宿主配置",
};

export function ConversationView({
  sessionId,
  messages,
  tasks,
  submission,
  cursor,
  busy,
  profiles,
  onEarlier,
  onSource,
  onUndo,
  onOpenWorkflow,
  onContinue,
  undos,
  onSuggest,
}: {
  sessionId: string;
  messages: Data[];
  tasks: Record<string, Data>;
  submission?: Data;
  cursor: string | null;
  busy: boolean;
  profiles: Data[];
  onEarlier: () => Promise<void>;
  onSource: (citation: Data) => void;
  onUndo: (tool: Data) => void;
  onOpenWorkflow: (id: string) => void;
  onContinue: () => void;
  undos: Record<string, Data>;
  onSuggest: (text: string) => void;
}) {
  const feed = useRef<HTMLDivElement>(null),
    following = useRef(true),
    previousSession = useRef(sessionId);
  const [newReply, setNewReply] = useState(false),
    [copied, setCopied] = useState("");
  const contentVersion =
    messages.map((m) => m.id + ":" + m.text?.length).join("|") +
    Object.values(tasks)
      .map(
        (t) =>
          t.id +
          ":" +
          t.status +
          ":" +
          t.partialText?.length +
          ":" +
          t.tools?.length,
      )
      .join("|") +
    submission?.status;
  const scroll = () => {
    if (feed.current) feed.current.scrollTop = feed.current.scrollHeight;
    following.current = true;
    setNewReply(false);
  };
  useLayoutEffect(() => {
    if (previousSession.current !== sessionId) {
      following.current = true;
      previousSession.current = sessionId;
    }
    if (following.current) scroll();
    else setNewReply(true);
  }, [contentVersion, sessionId]);
  useEffect(() => {
    if (!feed.current) return;
    const observer = new ResizeObserver(() => {
      if (following.current) scroll();
    });
    observer.observe(feed.current);
    return () => observer.disconnect();
  }, []);
  const turns = new Map<
    string,
    { user?: Data; answers: Data[]; task?: Data }
  >();
  for (const message of messages) {
    const key = message.taskId ?? message.id,
      turn = turns.get(key) ?? { answers: [], task: tasks[key] };
    if (message.role === "user") turn.user = message;
    else if (message.role === "assistant") turn.answers.push(message);
    turns.set(key, turn);
  }
  for (const [id, task] of Object.entries(tasks))
    if (!turns.has(id)) turns.set(id, { answers: [], task });
  const copy = async (id: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(id);
    } catch {
      setCopied("复制失败，请选择正文复制");
    }
  };
  return (
    <div className="assistant-feed-wrap">
      <div
        ref={feed}
        className="assistant-feed v2-messages"
        role="log"
        aria-label="助手对话"
        aria-live="polite"
        aria-relevant="additions text"
        onScroll={() => {
          const el = feed.current!;
          following.current =
            el.scrollHeight - el.scrollTop - el.clientHeight < 60;
          if (following.current) setNewReply(false);
        }}
      >
        {cursor && (
          <button
            className="assistant-earlier"
            onClick={() => {
              following.current = false;
              const el = feed.current!,
                height = el.scrollHeight,
                top = el.scrollTop;
              void onEarlier().then(() =>
                requestAnimationFrame(() => {
                  el.scrollTop = top + el.scrollHeight - height;
                }),
              );
            }}
          >
            加载更早消息
          </button>
        )}
        {!turns.size && !submission && (
          <div className="assistant-welcome">
            <span>✧</span>
            <h2>有什么我能帮你？</h2>
            <p>直接提问，或让我解释、修改当前工作流。</p>
            <div>
              {[
                "当前 MCP 有哪些？",
                "解释当前流程",
                "给当前流程生成测试建议",
              ].map((text) => (
                <button key={text} onClick={() => onSuggest(text)}>
                  {text}
                  <span>↗</span>
                </button>
              ))}
            </div>
          </div>
        )}
        {[...turns].map(([id, { user, answers, task }]) => {
          const expired = !!task?.resultsExpiredAt,
            text =
              answers
                .map((a) =>
                  a.resultsExpiredAt ? "内容已按保留策略到期" : a.text,
                )
                .join("\n\n") ||
              (!expired ? (task?.partialText ?? task?.answer ?? "") : "");
          const citations = answers.flatMap((a) => a.citations ?? []),
            tools: Data[] = task?.tools ?? [];
          const writes = tools.filter(
            (t) =>
              !t.isError && t.status === "COMPLETED" && t.result?.workflowId,
          );
          const question =
            user?.resultsExpiredAt || expired
              ? "内容已按保留策略到期"
              : (user?.text ?? task?.text);
          return (
            <article
              className="assistant-turn"
              key={id}
              data-task-id={task?.id}
              data-status={task?.status}
            >
              {question && (
                <div className="assistant-question">
                  <p>{question}</p>
                </div>
              )}
              <div className="assistant-answer-label">
                ✧ <span>FlowHub 助手</span>
              </div>
              {expired ? (
                <p>内容已按保留策略到期</p>
              ) : text ? (
                <Markdown text={text} />
              ) : task && activeTask(task) ? (
                <p className="assistant-thinking" role="status">
                  <span />
                  {task.status === "CALLING_TOOL"
                    ? "正在读取或更新相关信息…"
                    : "正在准备回复…"}
                </p>
              ) : (
                <p className="assistant-muted">
                  {task?.status === "COMPLETED"
                    ? "模型未返回正文，请查看本轮活动。"
                    : "本轮没有完成的回复。"}
                </p>
              )}
              {task && task.status !== "COMPLETED" && (
                <p
                  className={
                    "assistant-turn-status " +
                    (task.status === "FAILED" ? "error" : "")
                  }
                  role="status"
                >
                  {statusLabel[task.status] ?? task.status}
                  {task.errorCode ? " · " + task.errorCode : ""}
                  {task.status === "CANCELLED" || task.status === "INTERRUPTED"
                    ? "，已输出内容和工具回执已保留。"
                    : ""}
                </p>
              )}
              {task?.errorCode?.startsWith("MODEL_") && (
                <p className="assistant-muted">
                  {modelErrorHint(task.errorCode)}
                </p>
              )}
              {task &&
                ["FAILED", "CANCELLED", "INTERRUPTED"].includes(task.status) &&
                !expired && (
                  <button
                    className="assistant-continue"
                    disabled={busy}
                    onClick={onContinue}
                  >
                    继续回复
                  </button>
                )}
              {!!writes.length && !expired && (
                <div className="assistant-result-actions">
                  {writes.map((tool) => (
                    <div key={tool.id}>
                      <button
                        onClick={() => onOpenWorkflow(tool.result.workflowId)}
                      >
                        查看改动
                      </button>
                      {tool.result.commandId && (
                        <button
                          disabled={busy || undos[tool.id]?.pending}
                          onClick={() => onUndo(tool)}
                        >
                          {undos[tool.id]?.undone ? "重做改图" : "撤销改图"}
                        </button>
                      )}
                      {tool.result.revision && (
                        <small>已保存 r{tool.result.revision}</small>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="assistant-turn-footer">
                <details className="assistant-activity">
                  <summary>
                    {tools.length
                      ? tools.some((t) => t.isError)
                        ? "有工具调用未完成"
                        : `已记录 ${tools.length} 项活动`
                      : citations.length
                        ? "查看回答来源"
                        : "回复详情"}
                  </summary>
                  {tools.map((tool) => (
                    <details key={tool.id} className="assistant-tool">
                      <summary>
                        {toolLabel[tool.name] ?? tool.name} ·{" "}
                        {tool.isError
                          ? "失败"
                          : tool.status === "COMPLETED"
                            ? "已完成"
                            : "进行中"}
                      </summary>
                      <small>
                        {tool.name} · {tool.durationMs ?? "…"} ms
                      </small>
                      <pre>{JSON.stringify(tool.result, null, 2)}</pre>
                    </details>
                  ))}
                  {citations.map((c: Data, i: number) => (
                    <div className="assistant-citation" key={i}>
                      <span>
                        {c.sourcePath} · L{c.lineStart}–{c.lineEnd}
                      </span>
                      <button onClick={() => onSource(c)}>
                        查看实际引用资料
                      </button>
                    </div>
                  ))}
                  <small className="assistant-provenance">
                    {user?.contextRefs?.schemaVersion === 1
                      ? `来源：${user.contextRefs.runId ? "运行 " + user.contextRefs.runId : "项目帮助"}${user.contextRefs.workflowId ? " · 流程 " + user.contextRefs.workflowId : ""}`
                      : "历史消息来源未记录，不会自动发送给模型"}
                  </small>
                  {task && (
                    <small className="assistant-provenance">
                      任务：{task.status} · 模型{" "}
                      {profiles.find((p) => p.id === task.modelProfileId)
                        ?.name ?? "历史模型"}{" "}
                      · usage：
                      {task.usage ? JSON.stringify(task.usage) : "未知"}
                    </small>
                  )}
                </details>
                {text && !expired && (
                  <button
                    className="assistant-copy"
                    aria-label="复制回答"
                    onClick={() => void copy(id, text)}
                  >
                    {copied === id ? "已复制" : "⧉"}
                  </button>
                )}
              </div>
            </article>
          );
        })}
        {submission && (
          <article
            className="assistant-turn"
            data-status={
              submission.status === "sending"
                ? "SUBMITTING"
                : "SUBMISSION_FAILED"
            }
          >
            <div className="assistant-question">
              <p>{submission.payload.text}</p>
            </div>
            <p className="assistant-muted" role="status">
              {submission.status === "sending"
                ? "正在发送…"
                : "正在确认这条消息的发送结果。"}
            </p>
          </article>
        )}
      </div>
      {newReply && (
        <button className="assistant-new-reply" onClick={scroll}>
          有新回复 ↓
        </button>
      )}
    </div>
  );
}
