import { useCallback, useEffect, useRef, useState } from "react";
import type { Api } from "./v2";

export function useVaultState(api: Api, enabled = true) {
  const [locked, setLocked] = useState<boolean | null>(null);
  const alive = useRef(false),
    generation = useRef(0);
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    try {
      const state = await api("/auth/state");
      if (alive.current && request === generation.current)
        setLocked(typeof state.vaultLocked === "boolean" ? state.vaultLocked : null);
    } catch {
      if (alive.current && request === generation.current) setLocked(null);
    }
  }, [api]);
  useEffect(() => {
    if (!enabled) return;
    alive.current = true;
    setLocked(null);
    const changed = () => {
      void refresh();
    };
    const visible = () => {
      if (!document.hidden) changed();
    };
    changed();
    window.addEventListener("flowhub-credentials-changed", changed);
    window.addEventListener("focus", changed);
    document.addEventListener("visibilitychange", visible);
    return () => {
      alive.current = false;
      generation.current++;
      window.removeEventListener("flowhub-credentials-changed", changed);
      window.removeEventListener("focus", changed);
      document.removeEventListener("visibilitychange", visible);
    };
  }, [refresh, enabled]);
  return { locked, refresh };
}
