import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./shared";

const terminal = ["SUCCEEDED", "PARTIAL", "FAILED", "CANCELLED"];
export function useDiscovery(api: Api) {
  const call = useCallback(
    (path: string, method = "GET", body?: any) =>
      api("/api/v2" + path, method, body),
    [api],
  );
  const [contexts, setContexts] = useState<any[]>([]),
    [contextId, setContextId] = useState(""),
    [catalog, setCatalog] = useState<any>(null),
    [scan, setScan] = useState<any>(null);
  const [items, setItems] = useState<any[]>([]),
    [cursor, setCursor] = useState<string | null>(null),
    [total, setTotal] = useState(0),
    [error, setError] = useState("");
  const [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [registering, setRegistering] = useState(false);
  const [kind, setKind] = useState("mcp_server"),
    [query, setQuery] = useState(""),
    [executor, setExecutor] = useState(""),
    [source, setSource] = useState(""),
    [status, setStatus] = useState("");
  const epoch = useRef(0),
    listEpoch = useRef(0),
    selectionEpoch = useRef(0),
    registration = useRef(0),
    registrationPending = useRef(false),
    active = useRef(""),
    live = useRef(true),
    filters = useRef({ kind, query, executor, source, status });
  filters.current = { kind, query, executor, source, status };
  // The caller's API function can change on shell renders without restarting discovery.
  const callRef = useRef(call);
  callRef.current = call;
  const load = useCallback(async (id = active.current, next?: string) => {
    if (!id) return;
    const token = ++listEpoch.current;
    setLoading(true);
    const f = filters.current,
      params = new URLSearchParams({
        contextId: id,
        kind: f.kind === "issue" ? "mcp_server" : f.kind,
        query: f.query,
        limit: "20",
      });
    for (const [key, value] of Object.entries({
      executor: f.executor,
      source: f.source,
      status: f.status,
      cursor: next,
    }))
      if (value) params.set(key, value);
    try {
      const result = await callRef.current("/discovery/catalog?" + params);
      if (!live.current || token !== listEpoch.current || active.current !== id)
        return;
      setCatalog(result);
      setItems((previous) =>
        next ? [...previous, ...result.items] : result.items,
      );
      setCursor(result.nextCursor);
      setTotal(result.total);
    } finally {
      if (live.current && token === listEpoch.current) setLoading(false);
    }
  }, []);
  const poll = useCallback(
    async (id: string, scanId: string, token: number) => {
      while (live.current && token === epoch.current && id === active.current) {
        const job = await callRef.current(
          "/host-scans/" + encodeURIComponent(scanId),
        );
        if (!live.current || token !== epoch.current || id !== active.current)
          return;
        setScan(job);
        if (terminal.includes(job.status)) {
          await load(id);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    },
    [load],
  );
  const refresh = useCallback(
    async (depth = "metadata", selected = active.current) => {
      if (!selected) return;
      const token = ++epoch.current;
      setBusy(true);
      setScan(null);
      setError("");
      try {
        const accepted = await callRef.current("/host-scans", "POST", {
          contextId: selected,
          depth,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!live.current || token !== epoch.current) return;
        setScan({ id: accepted.scanId, status: accepted.status });
        await poll(selected, accepted.scanId, token);
      } catch (e) {
        if (live.current && token === epoch.current)
          setError((e as Error).message);
      } finally {
        if (live.current && token === epoch.current) setBusy(false);
      }
    },
    [poll],
  );
  const select = useCallback((id: string) => {
    selectionEpoch.current++;
    registration.current++;
    registrationPending.current = false;
    setRegistering(false);
    epoch.current++;
    listEpoch.current++;
    active.current = id;
    setContextId(id);
    setScan(null);
    setCatalog(null);
    setItems([]);
    setCursor(null);
    setBusy(false);
    setError("");
    localStorage.setItem("flowhub.discovery.context", id);
  }, []);
  useEffect(() => {
    live.current = true;
    void (async () => {
      try {
        let list = await callRef.current("/host-contexts");
        if (!list.length)
          list = [await callRef.current("/host-contexts", "POST", {})];
        if (!live.current) return;
        setContexts(list);
        select(
          (
            list.find(
              (c: any) =>
                c.id === localStorage.getItem("flowhub.discovery.context"),
            ) ?? list[0]
          ).id,
        );
      } catch (e) {
        if (live.current) setError((e as Error).message);
      }
    })();
    return () => {
      live.current = false;
      epoch.current++;
      listEpoch.current++;
      selectionEpoch.current++;
      registration.current++;
      registrationPending.current = false;
    };
  }, [select]);
  useEffect(() => {
    if (!contextId) return;
    const token = ++epoch.current;
    void (async () => {
      try {
        await load(contextId);
        if (!live.current || token !== epoch.current) return;
        const list = await callRef.current("/host-contexts");
        if (!live.current || token !== epoch.current) return;
        setContexts(list);
        const c = list.find((item: any) => item.id === contextId);
        if (c?.lastScanId) {
          const job = await callRef.current("/host-scans/" + c.lastScanId);
          if (!live.current || token !== epoch.current) return;
          setScan(job);
          if (!terminal.includes(job.status)) {
            setBusy(true);
            await poll(contextId, job.id, token);
            if (token === epoch.current) setBusy(false);
            return;
          }
        }
        if (!c?.catalogScanId) await refresh("metadata", contextId);
      } catch (e) {
        if (live.current && token === epoch.current) {
          setBusy(false);
          setError((e as Error).message);
        }
      }
    })();
  }, [contextId, load, poll, refresh]);
  useEffect(() => {
    if (!contextId) return;
    listEpoch.current++;
    const timer = setTimeout(() => {
      void load(contextId).catch((e) => {
        if (active.current === contextId) setError(e.message);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [contextId, kind, query, executor, source, status, load]);
  const tab = (value: string) => {
    if (value === kind && !query && !executor && !source && !status) return;
    // Rows belong to the old type until the debounced request returns. Clear
    // them immediately and invalidate in-flight responses before changing tabs.
    listEpoch.current++;
    setItems([]);
    setCursor(null);
    setTotal(0);
    setLoading(Boolean(active.current));
    setKind(value);
    setQuery("");
    setExecutor("");
    setSource("");
    setStatus("");
  };
  const register = async (form: any, update = false) => {
    if (registrationPending.current) return;
    const selected = active.current,
      selection = selectionEpoch.current,
      token = ++registration.current,
      current = () => live.current && selectionEpoch.current === selection &&
        registration.current === token && active.current === selected;
    registrationPending.current = true;
    setRegistering(true);
    setError("");
    try {
      const context = contexts.find((c) => c.id === selected);
      if (update && !context) throw new Error("请先选择要更新的本机上下文。");
      const value = await callRef.current("/host-contexts", "POST", {
        ...form,
        codexHome: form.codexHome || undefined,
        cwd: form.cwd || undefined,
        profile: form.profile === "" ? null : form.profile,
        codexPath:
          form.discoveryMode === "config_only"
            ? null
            : form.codexPath,
        ...(update ? { contextId: context.id, expectedRevision: context.revision } : {}),
      });
      if (!current()) return;
      const list = await callRef.current("/host-contexts");
      if (!current()) return;
      setContexts(list);
      if (value.id !== active.current) select(value.id);
      else await refresh("metadata", value.id);
    } catch (e) {
      if (current()) setError((e as Error).message);
    } finally {
      if (current()) {
        registrationPending.current = false;
        setRegistering(false);
      }
    }
  };
  return {
    call,
    contexts,
    contextId,
    context: contexts.find((c) => c.id === contextId),
    catalog,
    scan,
    items,
    cursor,
    total,
    error,
    setError,
    busy,
    loading,
    registering,
    kind,
    query,
    setQuery,
    executor,
    setExecutor,
    source,
    setSource,
    status,
    setStatus,
    select,
    tab,
    load,
    refresh,
    register,
    cancel: () =>
      scan?.id &&
      callRef
        .current("/host-scans/" + scan.id + "/cancel", "POST", {})
        .catch((e) => setError(e.message)),
  };
}
