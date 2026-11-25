import { useCallback, useEffect, useRef, useState } from "react";

type RunEvent = { seq: number };
type RunDetail = Record<string, any> & {
  runId: string;
  workflowId: string;
  state: string;
  events?: RunEvent[];
  eventCursor?: { nextAfter: number; hasMore: boolean };
};
type Reader = (path: string, signal: AbortSignal) => Promise<RunDetail>;

const terminal = new Set(["SUCCEEDED", "FAILED", "REJECTED", "CANCELLED", "OUTCOME_UNKNOWN"]);
const failedConnectionDelay = 2000;
const reconciliationDelay = 15000;
const eventBatchDelay = 50;

export function useRunDetail(runId: string | null, read: Reader) {
  const [view, setView] = useState<{
    runId: string;
    detail: (RunDetail & { events: RunEvent[] }) | null;
    issue: string | null;
  } | null>(null);
  const refreshRef = useRef<(() => Promise<boolean>) | null>(null);
  const refresh = useCallback(async () => (await refreshRef.current?.()) ?? false, []);

  useEffect(() => {
    setView(null);
    if (!runId) return;
    const selectedId = runId;
    const key = encodeURIComponent(selectedId);
    const controller = new AbortController();
    const { signal } = controller;
    let events: RunEvent[] = [];
    let cursor = 0, newestEvent = 0;
    let detail: (RunDetail & { events: RunEvent[] }) | null = null;
    let source: EventSource | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let reading: Promise<boolean> | undefined;
    let refreshAgain = false;
    let stopped = false;
    let eventQueued = false;
    let readFailed = false;

    function closeStream() {
      source?.close();
      source = undefined;
    }

    function schedule(delay: number) {
      clearTimeout(timer);
      if (!signal.aborted && !stopped && !reading)
        timer = setTimeout(() => { void update(); }, delay);
    }

    function watch() {
      if (source && source.readyState !== EventSource.CLOSED) return;
      closeStream();
      source = new EventSource("/api/v1/runs/" + key + "/events?after=" + cursor);
      source.onmessage = event => {
        const seq = Number(event.lastEventId);
        if (!Number.isSafeInteger(seq) || seq <= newestEvent || seq <= cursor) return;
        newestEvent = seq;
        // Keep the first timer in a burst so frequent events cannot starve the UI.
        if (!reading && !eventQueued) {
          eventQueued = true;
          schedule(eventBatchDelay);
        }
      };
      source.onopen = () => {
        if (!eventQueued) schedule(reconciliationDelay);
      };
      source.onerror = () => {
        if (!eventQueued) schedule(failedConnectionDelay);
      };
    }

    async function readPages() {
      try {
        let more: boolean;
        do {
          const page = await read("/runs/" + key + "?after=" + cursor, signal);
          if (signal.aborted) return;
          if (page?.runId !== selectedId) throw new Error("运行详情响应无效。");
          const next = Array.isArray(page.events) ? page.events.filter(event => event.seq > cursor) : [];
          if (next.length) events = [...events, ...next];
          const after = page.eventCursor?.nextAfter ?? events.at(-1)?.seq ?? cursor;
          more = (page.eventCursor?.hasMore ?? next.length === 200) && after > cursor;
          cursor = after;
          detail = { ...page, events };
          setView({ runId: selectedId, detail, issue: null });
        } while (more && !signal.aborted);
        stopped = terminal.has(detail?.state ?? "");
        readFailed = false;
        if (stopped) closeStream();
        else watch();
      } catch (error) {
        if (signal.aborted) return;
        readFailed = true;
        const missing = (error as { status?: number }).status === 404;
        stopped = missing || stopped;
        if (missing) {
          closeStream();
          detail = null;
        }
        setView({ runId: selectedId, detail, issue: missing
          ? "这条记录不存在，或已超过保留期限。"
          : (error as Error).message });
      }
    }

    function update(): Promise<boolean> {
      if (signal.aborted) return Promise.resolve(false);
      clearTimeout(timer);
      eventQueued = false;
      if (reading) {
        refreshAgain = true;
        return reading;
      }
      reading = (async () => {
        do {
          refreshAgain = false;
          const notified = newestEvent;
          await readPages();
          // A notification received during the read can require another read.
          // Already-requested events can disappear after retention or restore.
          if (newestEvent === notified || readFailed) newestEvent = cursor;
        } while (refreshAgain && !signal.aborted);
        return !readFailed && !signal.aborted;
      })().finally(() => {
        reading = undefined;
        if (newestEvent > cursor) {
          eventQueued = true;
          schedule(eventBatchDelay);
        } else {
          // Reconcile active runs after an interrupted stream and check idle
          // checkpoints periodically even when no new events are written.
          const streamHealthy = !readFailed && source?.readyState === EventSource.OPEN;
          schedule(streamHealthy ? reconciliationDelay : failedConnectionDelay);
        }
      });
      return reading;
    }

    refreshRef.current = update;
    const credentialsChanged = () => { void update(); };
    window.addEventListener("flowhub-credentials-changed", credentialsChanged);
    void update();
    return () => {
      window.removeEventListener("flowhub-credentials-changed", credentialsChanged);
      controller.abort();
      clearTimeout(timer);
      closeStream();
      refreshRef.current = null;
    };
  }, [runId, read]);

  return { run: view?.runId === runId ? view?.detail ?? null : null,
    issue: view?.runId === runId ? view?.issue ?? null : null, refresh };
}
