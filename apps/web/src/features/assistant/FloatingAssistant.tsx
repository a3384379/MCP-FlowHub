import { useEffect, useRef, useState } from "react";
import type { Api } from "../../shared/v2";
import { requestedActions } from "../../shared/v2";
import { useConversation, activeTask, type Data } from "./useConversation";
import { ConversationView } from "./ConversationView";
import "./assistant.css";

function Icon({
  name,
}: {
  name: "spark" | "close" | "new" | "history" | "expand" | "send";
}) {
  const paths = {
    spark: "m12 3 2.1 6.9L21 12l-6.9 2.1L12 21l-2.1-6.9L3 12l6.9-2.1L12 3Z",
    close: "m6 6 12 12M18 6 6 18",
    new: "M12 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7M15 3l6 6M11 13l-1 4 4-1 8-8-3-3-8 8Z",
    history: "M3 11a9 9 0 1 1 3 8M3 5v6h6m3-4v5l3 2",
    expand:
      "M8 3H3v5m0-5 6 6m7-6h5v5m0-5-6 6M3 16v5h5m-5 0 6-6m12 1v5h-5m5 0-6-6",
    send: "M12 20V4m-6 6 6-6 6 6",
  };
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={paths[name]} />
    </svg>
  );
}
export function FloatingAssistant({
  api,
  context,
  contextLabel,
  dirty,
  openRequest,
  workflows,
  runs,
  onNavigate,
  onOpenWorkflow,
}: {
  api: Api;
  context: Data;
  contextLabel: string;
  dirty: boolean;
  openRequest: number;
  workflows: Data[];
  runs: Data[];
  onNavigate: (path: string) => void;
  onOpenWorkflow: (id: string) => void;
}) {
  const chat = useConversation(api);
  const [opened, setOpened] = useState(false),
    [wide, setWide] = useState(false),
    [history, setHistory] = useState(false),
    [details, setDetails] = useState(false),
    [unread, setUnread] = useState(false);
  const [override, setOverride] = useState<Data | null>(null),
    [detached, setDetached] = useState(false),
    [source, setSource] = useState<Data | null>(null),
    [help, setHelp] = useState<Data | null>(null),
    [undos, setUndos] = useState<Record<string, Data>>({});
  const launcher = useRef<HTMLButtonElement>(null),
    input = useRef<HTMLTextAreaElement>(null),
    windowRef = useRef<HTMLElement>(null);
  const previousRequest = useRef(openRequest),
    previousScope = useRef(""),
    sourceVersion = useRef(0),
    openedRef = useRef(opened);
  const undoPending = useRef(new Map<string, Data>());
  const seenTasks = useRef(new Map<string, string>());
  const wasOpened = useRef(false);
  openedRef.current = opened;
  const effectiveContext = detached ? {} : (override ?? context);
  const runOptions: Data[] = runs.map((run) => ({
    ...run,
    runId: run.runId ?? run.id,
  }));
  const scope = JSON.stringify({
    workflowId: context.workflowId,
    runId: context.runId,
  });
  const selected = chat.profiles.find((p) => p.id === chat.profileId),
    running = Object.values(chat.entry.tasks).some(activeTask);
  const ready = !!selected?.keyConfigured;
  const close = () => {
    setOpened(false);
    setHistory(false);
    setDetails(false);
  };
  const open = () => {
    setOpened(true);
    setUnread(false);
  };
  useEffect(() => {
    if (previousRequest.current !== openRequest) {
      previousRequest.current = openRequest;
      open();
    }
  }, [openRequest]);
  useEffect(() => {
    if (previousScope.current !== scope) {
      previousScope.current = scope;
      setOverride(null);
      setDetached(false);
    }
  }, [scope]);
  useEffect(() => {
    if (opened) {
      input.current?.focus({ preventScroll: true });
      void chat.loadProfiles().catch(chat.reportError);
      void chat.refresh(chat.sessionId).catch(chat.reportError);
    } else if (wasOpened.current)
      launcher.current?.focus({ preventScroll: true });
    wasOpened.current = opened;
  }, [opened]);
  useEffect(() => {
    const field = input.current;
    if (field) {
      field.style.height = "44px";
      field.style.height =
        Math.min(140, Math.max(44, field.scrollHeight)) + "px";
    }
  }, [chat.entry.text, opened]);
  useEffect(() => {
    sourceVersion.current++;
    setSource(null);
    setHelp(null);
  }, [chat.sessionId]);
  useEffect(() => {
    for (const task of Object.values(chat.entry.tasks)) {
      const prior = seenTasks.current.get(task.id);
      if (
        !openedRef.current &&
        prior &&
        ["GENERATING", "CALLING_TOOL"].includes(prior) &&
        !["GENERATING", "CALLING_TOOL"].includes(task.status)
      )
        setUnread(true);
      seenTasks.current.set(task.id, task.status);
    }
  }, [chat.entry.tasks]);
  useEffect(() => {
    const viewport = window.visualViewport;
    const resize = () => {
      const box = windowRef.current;
      if (!box) return;
      box.style.setProperty(
        "--assistant-viewport-height",
        (viewport?.height ?? window.innerHeight) + "px",
      );
      box.style.setProperty(
        "--assistant-viewport-top",
        (viewport?.offsetTop ?? 0) + "px",
      );
    };
    resize();
    viewport?.addEventListener("resize", resize);
    viewport?.addEventListener("scroll", resize);
    window.addEventListener("resize", resize);
    return () => {
      viewport?.removeEventListener("resize", resize);
      viewport?.removeEventListener("scroll", resize);
      window.removeEventListener("resize", resize);
    };
  }, []);
  const undo = async (tool: Data) => {
    const id = tool.id;
    setUndos((old) => ({ ...old, [id]: { ...old[id], pending: true } }));
    try {
      let pending = undoPending.current.get(id);
      if (!pending) {
        const workflow = await api(
          "/api/v2/workflows/" + tool.result.workflowId + "/draft",
        );
        pending = {
          workflowId: tool.result.workflowId,
          commandId: undos[id]?.commandId ?? tool.result.commandId,
          expectedRevision: workflow.revision,
          idempotencyKey: crypto.randomUUID(),
        };
        undoPending.current.set(id, pending);
      }
      const { workflowId, ...body } = pending;
      const result = await api(
        "/api/v2/workflows/" + workflowId + "/undo",
        "POST",
        body,
      );
      undoPending.current.delete(id);
      setUndos((old) => ({
        ...old,
        [id]: { ...result, undone: !old[id]?.undone, pending: false },
      }));
    } catch (error) {
      setUndos((old) => ({ ...old, [id]: { ...old[id], pending: false } }));
      chat.reportError(error);
    }
  };
  const showSource = async (citation: Data) => {
    const version = ++sourceVersion.current;
    try {
      const query = new URLSearchParams({
        chunkId: citation.chunkId,
        contentHash: citation.contentHash,
        lineStart: String(citation.lineStart),
        lineEnd: String(citation.lineEnd),
      });
      const result = await api("/api/v2/help/source?" + query);
      if (version === sourceVersion.current) setSource(result);
    } catch (error) {
      if (version === sourceVersion.current) chat.reportError(error);
    }
  };
  const selectedLabel = detached
    ? "未附带页面上下文"
    : override
      ? override.runId
        ? "已选运行"
        : "已选流程"
      : contextLabel;
  const safe = (work: Promise<unknown>) => void work.catch(chat.reportError);
  return (
    <>
      <button
        ref={launcher}
        className="assistant-launcher"
        aria-label={opened ? "收起 FlowHub 助手" : "打开 FlowHub 助手"}
        aria-expanded={opened}
        aria-controls="flowhub-assistant-window"
        onClick={() => (opened ? close() : open())}
      >
        <Icon name="spark" />
        {unread && !opened && (
          <span className="assistant-unread" aria-label="有新回复" />
        )}
      </button>
      <section
        ref={windowRef}
        id="flowhub-assistant-window"
        data-session-id={chat.sessionId}
        className={"floating-assistant " + (wide ? "assistant-wide" : "")}
        aria-label="FlowHub 助手聊天窗口"
        hidden={!opened}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !e.nativeEvent.isComposing) {
            e.stopPropagation();
            if (source) {
              sourceVersion.current++;
              setSource(null);
            } else if (history || details) {
              setHistory(false);
              setDetails(false);
              input.current?.focus();
            } else close();
          }
        }}
      >
        <header className="assistant-header">
          <span className="assistant-brand-icon">
            <Icon name="spark" />
          </span>
          <div>
            <strong>FlowHub 助手</strong>
            <small>
              {chat.connection === "reconnecting"
                ? "正在重连，任务会继续保留"
                : "聊聊当前项目"}
            </small>
          </div>
          <div className="assistant-header-actions">
            <button
              aria-label="历史对话"
              aria-expanded={history}
              onClick={() => {
                setHistory(!history);
                setDetails(false);
              }}
            >
              <Icon name="history" />
            </button>
            <button
              aria-label="新建会话"
              disabled={chat.loading || chat.switching}
              onClick={() => {
                setHistory(false);
                safe(chat.create());
              }}
            >
              <Icon name="new" />
            </button>
            <button
              aria-label={wide ? "恢复小窗" : "放大聊天窗口"}
              onClick={() => setWide(!wide)}
            >
              <Icon name="expand" />
            </button>
            <button aria-label="收起聊天窗口" onClick={close}>
              <Icon name="close" />
            </button>
          </div>
        </header>
        {history && (
          <div className="assistant-popover" aria-label="会话管理">
            <label>
              助手会话
              <select
                aria-label="助手会话"
                value={chat.sessionId}
                onChange={(e) => {
                  safe(chat.choose(e.target.value));
                  setHistory(false);
                }}
              >
                {chat.sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.title ?? "新对话"}
                    {s.active ? " · 回复中" : ""} ·{" "}
                    {new Date(s.updatedAt ?? s.createdAt).toLocaleDateString()}
                  </option>
                ))}
              </select>
            </label>
            <button
              disabled={chat.busy || !chat.sessionId}
              onClick={() => safe(chat.remove())}
            >
              删除当前会话
            </button>
            <p>消息保存在本机。切换会话不会取消后台任务。</p>
          </div>
        )}
        <div className="assistant-context">
          <button
            className="assistant-context-chip"
            aria-label="发送上下文与模型状态"
            aria-expanded={details}
            onClick={() => {
              setDetails(!details);
              setHistory(false);
            }}
          >
            ▦ {selectedLabel}
            {effectiveContext.selectedNodeIds?.length
              ? " · " + effectiveContext.selectedNodeIds.length + " 个节点"
              : ""}
          </button>
          {!detached && (
            <button
              className="assistant-detach"
              aria-label="移除当前页面上下文"
              onClick={() => {
                setDetached(true);
                setOverride(null);
              }}
            >
              ×
            </button>
          )}
        </div>
        {details && (
          <div className="assistant-context-details">
            <p>
              模型：{selected?.name ?? "未配置"} · {selected?.model ?? ""}
            </p>
            <p>
              只发送所选页面信息、同一来源和模型的近期对话。其他运行及来源不明的旧消息仅保存在本机。
            </p>
            <p>
              本次动作范围：
              {requestedActions(chat.entry.text).join("、") || "检索与解释"}
            </p>
            <label>
              关联流程
              <select
                aria-label="关联流程"
                value={effectiveContext.workflowId ?? ""}
                disabled={chat.busy}
                onChange={(e) => {
                  setDetached(false);
                  setOverride(
                    e.target.value ? { workflowId: e.target.value } : null,
                  );
                }}
              >
                <option value="">使用当前页面</option>
                {workflows.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.draft?.name ?? w.name ?? w.id}
                  </option>
                ))}
              </select>
            </label>
            <label>
              关联运行
              <select
                aria-label="关联运行"
                value={effectiveContext.runId ?? ""}
                disabled={chat.busy}
                onChange={(e) => {
                  setDetached(false);
                  const run = runOptions.find(
                    (r) => r.runId === e.target.value,
                  );
                  setOverride(
                    run
                      ? { workflowId: run.workflowId, runId: run.runId }
                      : null,
                  );
                }}
              >
                <option value="">不附带额外运行</option>
                {runOptions.map((r) => (
                  <option key={r.runId} value={r.runId}>
                    {r.workflowId} · {r.state} · {r.runId.slice(-6)}
                  </option>
                ))}
              </select>
            </label>
            {(effectiveContext.runId || override) && (
              <button
                onClick={() => {
                  setOverride(null);
                  setDetached(true);
                }}
              >
                清除运行上下文
              </button>
            )}
            {effectiveContext.runId && (
              <p>
                运行 {effectiveContext.runId}
                ；仅附带当前运行，不发送其他历史业务结果。
              </p>
            )}
            {!!effectiveContext.artifactRefs?.length && (
              <p>
                附带当前选中的 {effectiveContext.artifactRefs.length}{" "}
                份证据，每份最多发送前 16000 bytes；完整内容继续保存在本机。
              </p>
            )}
            {detached && (
              <button onClick={() => setDetached(false)}>
                重新附带当前页面
              </button>
            )}
          </div>
        )}
        {dirty && effectiveContext.workflowId && (
          <p className="assistant-notice">
            本地有未保存编辑。AI 改图将使用现有冲突合并，不覆盖输入。
          </p>
        )}
        {chat.initialError && (
          <p className="assistant-notice error" role="alert">
            {chat.initialError}
            <button onClick={() => safe(chat.initialize())}>重新读取</button>
          </p>
        )}
        {chat.loading ? (
          <p className="assistant-loading" role="status">
            正在读取本机会话…
          </p>
        ) : (
          <ConversationView
            sessionId={chat.sessionId}
            messages={chat.entry.messages}
            tasks={chat.entry.tasks}
            submission={chat.entry.submission}
            cursor={chat.entry.cursor}
            busy={chat.busy || !ready}
            profiles={chat.profiles}
            undos={undos}
            onEarlier={() =>
              chat
                .refresh(chat.sessionId, chat.entry.cursor!)
                .catch(chat.reportError)
            }
            onSource={(c) => safe(showSource(c))}
            onUndo={(tool) => safe(undo(tool))}
            onOpenWorkflow={onOpenWorkflow}
            onContinue={() =>
              safe(
                chat.send(
                  effectiveContext,
                  "请根据上一轮已保存的工具回执继续回复，只解释结果，不要重复执行操作。",
                ),
              )
            }
            onSuggest={(text) => {
              chat.setText(text);
              input.current?.focus();
            }}
          />
        )}
        {source && (
          <section className="assistant-source" aria-label="引用资料">
            <header>
              <strong>{source.sourcePath}</strong>
              <button
                aria-label="关闭资料"
                onClick={() => {
                  sourceVersion.current++;
                  setSource(null);
                }}
              >
                ×
              </button>
            </header>
            {source.stale && <p role="alert">来源已改变，此引用已过期。</p>}
            <small>
              L{source.lineStart}–{source.lineEnd}
            </small>
            <pre>{source.content}</pre>
          </section>
        )}
        {help && (
          <section className="assistant-source" aria-label="本地资料检索">
            <header>
              <strong>本地资料检索</strong>
              <button onClick={() => setHelp(null)}>关闭</button>
            </header>
            {help.excerpts.map((c: Data) => (
              <div key={c.id}>
                <p>{c.content}</p>
                <button onClick={() => safe(showSource(c))}>
                  查看实际引用资料
                </button>
              </div>
            ))}
          </section>
        )}
        <footer className="assistant-composer">
          {!ready && (
            <p className="assistant-notice">
              配置模型后启用聊天。发现、画布和 Codex 路径仍可用。
              <button onClick={() => onNavigate("/models")}>
                前往模型设置
              </button>
            </p>
          )}
          {chat.entry.error && (
            <p className="assistant-notice error" role="alert">
              {chat.entry.error}
              <button aria-label="关闭助手错误" onClick={chat.clearError}>
                ×
              </button>
            </p>
          )}
          <form
            onSubmit={(e) => {
              e.preventDefault();
              safe(chat.send(effectiveContext));
            }}
          >
            <div className="assistant-input-box">
              <textarea
                ref={input}
                aria-label="发送给助手"
                disabled={chat.loading || chat.switching}
                rows={2}
                value={chat.entry.text}
                onChange={(e) => chat.setText(e.target.value)}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    if (!running && ready) safe(chat.send(effectiveContext));
                  }
                }}
                placeholder="问一个问题，或说说你想做什么…"
              />
              <div className="assistant-composer-tools">
                <select
                  aria-label="使用模型"
                  value={chat.profileId}
                  disabled={chat.busy}
                  onChange={(e) => chat.selectProfile(e.target.value)}
                >
                  <option value="" disabled>
                    选择模型
                  </option>
                  {chat.profiles.map((p) => (
                    <option value={p.id} key={p.id}>
                      {p.name} · {p.model}
                    </option>
                  ))}
                </select>
                {running ? (
                  <button
                    type="button"
                    className="assistant-send"
                    aria-label="停止回复"
                    onClick={() => safe(chat.cancel())}
                  >
                    <span className="assistant-stop" />
                  </button>
                ) : (
                  <button
                    className="assistant-send"
                    type="submit"
                    aria-label={
                      chat.entry.submission?.status === "uncertain"
                        ? "重试发送"
                        : "发送"
                    }
                    disabled={
                      chat.loading ||
                      chat.switching ||
                      !ready ||
                      !chat.sessionId ||
                      chat.entry.submission?.status === "sending" ||
                      (!chat.entry.text.trim() && !chat.entry.submission)
                    }
                  >
                    <Icon name="send" />
                  </button>
                )}
              </div>
            </div>
          </form>
          <div className="assistant-compose-hint">
            <span>Enter 发送 · Shift + Enter 换行</span>
            {!ready && (
              <button
                disabled={!chat.entry.text.trim()}
                onClick={() =>
                  safe(
                    api(
                      "/api/v2/help/search?query=" +
                        encodeURIComponent(chat.entry.text),
                    ).then(setHelp),
                  )
                }
              >
                检索本地帮助
              </button>
            )}
          </div>
        </footer>
      </section>
    </>
  );
}
