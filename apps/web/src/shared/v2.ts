export { requestedActions } from "../../../../packages/contracts/src/assistant-intent.js";
export type Api=(path:string,method?:string,body?:any,revision?:number)=>Promise<any>;
type Connection = "open" | "reconnecting";
type Subscription = {
  listener: (event: any) => void;
  onConnection?: (state: Connection) => void;
};
const subscriptions = new Set<Subscription>();
let cursor = 0;
let source: EventSource | undefined;
let retry: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;
let recoverSession: () => Promise<void>;

export function initializeEvents(after: number, recover: () => Promise<void>) {
  cursor = Number.isSafeInteger(after) && after >= 0 ? after : 0;
  recoverSession = recover;
}

function connect() {
  clearTimeout(retry);
  source?.close();
  const stream = new EventSource("/api/v2/events?afterEventId=" + cursor);
  source = stream;
  const publish = (notify: (item: Subscription) => void) => {
    if (source !== stream) return;
    for (const item of subscriptions) {
      try { notify(item); } catch (error) { console.error(error); }
    }
  };
  stream.onopen = () => {
    if (source !== stream) return;
    retryDelay = 1000;
    publish(item => item.onConnection?.("open"));
  };
  stream.onerror = () => {
    if (source !== stream) return;
    publish(item => item.onConnection?.("reconnecting"));
    if (stream.readyState !== EventSource.CLOSED) return;
    // The browser retries interrupted streams, but stops after an HTTP error.
    clearTimeout(retry);
    retry = setTimeout(async () => {
      if (source !== stream) return;
      try { await recoverSession(); } finally {
        if (source === stream) connect();
      }
    }, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 15000);
  };
  stream.onmessage = event => {
    if (source !== stream) return;
    let value;
    try { value = JSON.parse(event.data); } catch { return; }
    if (!value || typeof value.type !== "string") return;
    const id = Number(event.lastEventId) || value.eventId;
    if (!Number.isSafeInteger(id) || id <= cursor) return;
    cursor = id;
    if (value.type !== "cursor") publish(item => item.listener(value));
  };
}

export function subscribeEvents(listener: Subscription["listener"], onConnection?: Subscription["onConnection"]) {
  const item = { listener, onConnection };
  subscriptions.add(item);
  if (!source) {
    connect();
    window.addEventListener("flowhub-session-restored", connect);
  } else if (source.readyState === EventSource.OPEN) onConnection?.("open");
  return () => {
    subscriptions.delete(item);
    if (subscriptions.size) return;
    window.removeEventListener("flowhub-session-restored", connect);
    clearTimeout(retry);
    retryDelay = 1000;
    source?.close();
    source = undefined;
  };
}
