import { useCallback, useEffect, useRef, useState } from "react";
import { requestedActions, subscribeEvents, type Api } from "../../shared/v2";

export type Data = Record<string, any>;
export type Submission = {
  key: string;
  payload: Data;
  status: "sending" | "uncertain";
};
type Entry = {
  messages: Data[];
  tasks: Record<string, Data>;
  text: string;
  cursor: string | null;
  error: string;
  submission?: Submission;
};
const empty = (): Entry => ({
  messages: [],
  tasks: {},
  text: "",
  cursor: null,
  error: "",
});
export const activeTask = (task: Data) =>
  ["GENERATING", "CALLING_TOOL"].includes(task.status);
const stored = (key: string) => {
  try {
    return localStorage.getItem(key) ?? "";
  } catch {
    return "";
  }
};
const remember = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* Storage is optional. */
  }
};
const mergeMessages = (first: Data[], second: Data[]) => [
  ...new Map([...first, ...second].map((m) => [m.id, m])).values(),
];
// These responses reject the request before acceptance. A timeout or transport
// failure may have lost a successful receipt, so it must retain the original key.
const rejected = (error: unknown) => {
  const status = (error as { status?: number })?.status;
  return (
    typeof status === "number" &&
    status >= 400 &&
    status < 500 &&
    status !== 408
  );
};

/** Mounted once by the app shell, independently of window visibility and route. */
export function useConversation(api: Api) {
  const [sessions, setSessions] = useState<Data[]>([]),
    [sessionId, setSessionId] = useState("");
  const [profiles, setProfiles] = useState<Data[]>([]),
    [profileId, setProfileId] = useState(stored("flowhub-assistant-model"));
  const [entries, setEntries] = useState<Record<string, Entry>>({}),
    [loading, setLoading] = useState(true);
  const [switching, setSwitching] = useState(false),
    selectionVersion = useRef(0);
  const [connection, setConnection] = useState("open"),
    [initialError, setInitialError] = useState("");
  const mounted = useRef(false),
    current = useRef(""),
    entriesRef = useRef(entries);
  const pending = useRef(new Map<string, Submission>()),
    versions = useRef(new Map<string, number>());
  const eventVersions = useRef(new Map<string, number>()),
    serial = useRef(0);
  entriesRef.current = entries;
  const patch = useCallback((id: string, change: (entry: Entry) => Entry) => {
    if (mounted.current)
      setEntries((old) => ({ ...old, [id]: change(old[id] ?? empty()) }));
  }, []);
  const fail = useCallback(
    (id: string, error: unknown) =>
      patch(id, (e) => ({ ...e, error: (error as Error).message })),
    [patch],
  );
  const loadProfiles = useCallback(async () => {
    const models = (await api("/api/v2/model-profiles")).filter(
      (p: Data) => !p.disabled,
    );
    if (!mounted.current) return;
    setProfiles(models);
    setProfileId((old) =>
      models.some((p: Data) => p.id === old) ? old : (models[0]?.id ?? ""),
    );
  }, [api]);
  const loadSessions = useCallback(async () => {
    const list = await api("/api/v2/assistant/sessions");
    if (mounted.current) setSessions(list);
    return list as Data[];
  }, [api]);
  const refresh = useCallback(
    async (id: string, before?: string) => {
      if (!id) return;
      const slot = id + (before ? ":history" : ":latest"),
        version = (versions.current.get(slot) ?? 0) + 1;
      versions.current.set(slot, version);
      const atStart = serial.current,
        proposal = pending.current.get(id);
      const page = await api(
        "/api/v2/assistant/sessions/" +
          id +
          "/conversation" +
          (before ? "?before=" + encodeURIComponent(before) : ""),
      );
      if (!mounted.current || versions.current.get(slot) !== version) return;
      const recovered =
        proposal &&
        page.tasks.some((t: Data) => t.idempotencyKey === proposal.key);
      if (recovered && pending.current.get(id)?.key === proposal.key)
        pending.current.delete(id);
      patch(id, (entry) => {
        const tasks = { ...entry.tasks };
        for (const next of page.tasks) {
          // An older HTTP snapshot cannot replace more recent SSE state.
          if (
            (eventVersions.current.get(next.id) ?? 0) > atStart &&
            tasks[next.id]
          )
            continue;
          tasks[next.id] = next;
        }
        return {
          ...entry,
          tasks,
          messages: before
            ? mergeMessages(page.items, entry.messages)
            : mergeMessages(entry.messages, page.items),
          cursor:
            before || !entry.messages.length ? page.nextCursor : entry.cursor,
          ...(recovered && entry.submission?.key === proposal.key
            ? {
                submission: undefined,
                error: "",
                text: entry.text === proposal.payload.text ? "" : entry.text,
              }
            : {}),
        };
      });
    },
    [api, patch],
  );
  const choose = useCallback(
    async (id: string) => {
      const version = ++selectionVersion.current;
      setSwitching(true);
      current.current = id;
      setSessionId(id);
      remember("flowhub-assistant-session", id);
      try {
        await refresh(id);
      } finally {
        if (mounted.current && version === selectionVersion.current)
          setSwitching(false);
      }
    },
    [refresh],
  );
  const create = useCallback(async () => {
    const version = ++selectionVersion.current;
    setSwitching(true);
    try {
      const next = await api("/api/v2/assistant/sessions", "POST", {});
      if (!mounted.current) return;
      setSessions((old) => [...old, next]);
      if (version !== selectionVersion.current) return;
      current.current = next.id;
      setSessionId(next.id);
      remember("flowhub-assistant-session", next.id);
      patch(next.id, () => empty());
    } finally {
      if (mounted.current && version === selectionVersion.current)
        setSwitching(false);
    }
  }, [api, patch]);
  const remove = useCallback(async () => {
    const id = current.current;
    await api("/api/v2/assistant/sessions/" + id, "DELETE");
    const list = await loadSessions();
    if (!mounted.current || current.current !== id) return;
    pending.current.delete(id);
    setEntries((old) => {
      const next = { ...old };
      delete next[id];
      return next;
    });
    if (list.length) await choose(list.at(-1)!.id);
    else await create();
  }, [api, choose, create, loadSessions]);
  const send = useCallback(
    async (context: Data, textOverride?: string, continueTaskId?: string) => {
      const id = current.current,
        entry = entriesRef.current[id] ?? empty();
      if (
        !id ||
        Object.values(entry.tasks).some(activeTask) ||
        pending.current.get(id)?.status === "sending"
      )
        return;
      let proposal = pending.current.get(id);
      if (!proposal) {
        const text = (textOverride ?? entry.text).trim();
        if (!text || !profileId) return;
        const actions = continueTaskId ? [] : requestedActions(text);
        proposal = {
          key: crypto.randomUUID(),
          status: "sending",
          payload: {
            text,
            context: structuredClone(context),
            requestedActions: actions,
            mode: actions.length ? "compose" : "help",
            modelProfileId: profileId,
            ...(continueTaskId ? { continueTaskId } : {}),
          },
        };
      }
      proposal = { ...proposal, status: "sending" };
      const request = proposal;
      pending.current.set(id, request);
      patch(id, (e) => ({ ...e, error: "", submission: request }));
      try {
        const accepted = await api(
          "/api/v2/assistant/sessions/" + id + "/messages",
          "POST",
          { ...request.payload, idempotencyKey: request.key },
        );
        if (!mounted.current) return;
        if (pending.current.get(id)?.key === request.key)
          pending.current.delete(id);
        patch(id, (e) => ({
          ...e,
          ...(e.submission?.key === request.key
            ? {
                submission: undefined,
                error: "",
                text: e.text === request.payload.text ? "" : e.text,
              }
            : {}),
          tasks: {
            ...e.tasks,
            [accepted.taskId]: e.tasks[accepted.taskId] ?? {
              ...request.payload,
              id: accepted.taskId,
              sessionId: id,
              status: accepted.status,
              createdAt: new Date().toISOString(),
              tools: [],
            },
          },
        }));
        // Reconciliation errors cannot turn an accepted request into a failed
        // send, or overwrite a later submission's error/input state.
        void refresh(id).catch(() => {});
        void loadSessions().catch(() => {});
      } catch (error) {
        if (pending.current.get(id)?.key === request.key) {
          if (rejected(error)) {
            pending.current.delete(id);
            patch(id, (e) =>
              e.submission?.key === request.key
                ? {
                    ...e,
                    submission: undefined,
                    error: (error as Error).message,
                  }
                : e,
            );
            return;
          }
          const uncertain: Submission = { ...request, status: "uncertain" };
          pending.current.set(id, uncertain);
          patch(id, (e) =>
            e.submission?.key === request.key
              ? {
                  ...e,
                  submission: uncertain,
                  error: "发送结果尚未确认。重试会恢复同一请求，不会重复执行。",
                }
              : e,
          );
          // The server may have accepted the request even when its HTTP receipt was lost.
          void refresh(id).catch(() => {});
        }
      }
    },
    [api, loadSessions, patch, profileId, refresh],
  );
  const cancel = useCallback(async () => {
    const id = current.current,
      task = Object.values(entriesRef.current[id]?.tasks ?? {}).find(
        activeTask,
      );
    if (!task) return;
    const value = await api(
      "/api/v2/assistant/tasks/" + task.id + "/cancel",
      "POST",
      {},
    );
    if (!mounted.current) return;
    serial.current++;
    eventVersions.current.set(task.id, serial.current);
    patch(id, (e) => ({ ...e, tasks: { ...e.tasks, [task.id]: value } }));
    await refresh(id);
  }, [api, patch, refresh]);
  const initialize = useCallback(async () => {
    setLoading(true);
    setInitialError("");
    try {
      const [, list] = await Promise.all([loadProfiles(), loadSessions()]);
      if (!mounted.current) return;
      if (!list.length) await create();
      else
        await choose(
          list.find((s) => s.id === stored("flowhub-assistant-session"))?.id ??
            list.at(-1)!.id,
        );
    } catch (error) {
      if (mounted.current) setInitialError((error as Error).message);
    } finally {
      if (mounted.current) setLoading(false);
    }
  }, [choose, create, loadProfiles, loadSessions]);
  useEffect(() => {
    mounted.current = true;
    void initialize();
    const unsubscribe = subscribeEvents(
      (event) => {
        if (!event.taskId) return;
        const id =
          Object.keys(entriesRef.current).find(
            (id) => entriesRef.current[id]?.tasks[event.taskId],
          ) ?? current.current;
        if (!id) return;
        const task = entriesRef.current[id]?.tasks[event.taskId];
        if (
          task &&
          (event.type === "message.delta" || event.type === "message.started")
        ) {
          serial.current++;
          eventVersions.current.set(task.id, serial.current);
          patch(id, (e) => {
            const old = e.tasks[task.id];
            if (!old || !activeTask(old)) return e;
            const round = event.data.round ?? old.rounds;
            if (round < (old.rounds ?? 0)) return e;
            if (event.type === "message.started" && round === (old.rounds ?? 0))
              return e;
            if (
              event.type === "message.delta" &&
              event.data.offset !== undefined &&
              (round === (old.rounds ?? 0)
                ? (old.partialText ?? "").length
                : 0) !== event.data.offset
            )
              return e;
            return {
              ...e,
              tasks: {
                ...e.tasks,
                [task.id]: {
                  ...old,
                  rounds: event.data.round ?? old.rounds,
                  partialText:
                    event.type === "message.started"
                      ? ""
                      : (round > (old.rounds ?? 0)
                          ? ""
                          : (old.partialText ?? "")) + event.data.text,
                },
              },
            };
          });
        }
        if (
          event.type.startsWith("tool.") ||
          event.type.startsWith("task.") ||
          !task
        )
          void refresh(id).catch((error) => fail(id, error));
        if (event.type.startsWith("task.")) void loadSessions().catch(() => {});
      },
      undefined,
      (state) => {
        if (!mounted.current) return;
        setConnection(state);
        if (state === "open" && current.current)
          void refresh(current.current).catch(() => {});
      },
    );
    // Reconciliation repairs lost deltas/status and HTTP acceptance; it never resubmits.
    const interval = setInterval(() => {
      for (const [id, entry] of Object.entries(entriesRef.current))
        if (Object.values(entry.tasks).some(activeTask) || entry.submission)
          void refresh(id).catch(() => {});
    }, 1800);
    const focus = () => {
      if (current.current) void refresh(current.current).catch(() => {});
      void loadProfiles().catch(() => {});
    };
    window.addEventListener("focus", focus);
    return () => {
      mounted.current = false;
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener("focus", focus);
    };
  }, [fail, initialize, loadProfiles, loadSessions, patch, refresh]);
  const selectProfile = (id: string) => {
    setProfileId(id);
    remember("flowhub-assistant-model", id);
  };
  const entry = entries[sessionId] ?? empty();
  return {
    sessions,
    sessionId,
    profiles,
    profileId,
    selectProfile,
    entry,
    loading,
    switching,
    connection,
    initialError,
    choose,
    create,
    remove,
    send,
    cancel,
    refresh,
    loadProfiles,
    initialize,
    setText: (text: string) => patch(current.current, (e) => ({ ...e, text })),
    clearError: () => patch(current.current, (e) => ({ ...e, error: "" })),
    reportError: (error: unknown) => fail(current.current, error),
    busy:
      switching ||
      !!entry.submission ||
      Object.values(entry.tasks).some(activeTask),
  };
}
