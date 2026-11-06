import { useCallback, useEffect, useRef, useState } from "react";

/**
 * usePanelFeed — one panel's read, Builds (#3) and WhatsApp (#5) alike.
 *
 * Keeps the LAST GOOD payload when a fetch fails (design C19: old truth,
 * labelled as old, beats a blank screen) and reloads when the app comes back
 * to the foreground, the way ReviewList does. Memory only: it never touches
 * the localStorage snapshot (lib/cache.ts) — customer data must not land
 * there, and a panel is cheap to refetch.
 */
export interface PanelFeed<T> {
  data: T | null;
  /** When `data` was fetched (ms). */
  lastGoodAt: number | null;
  /** The last fetch failed — `data` (if any) is stale. */
  error: string | null;
  loading: boolean;
  reload: () => void;
}

export function usePanelFeed<T>(url: string | null, rev = 0): PanelFeed<T> {
  const [data, setData] = useState<T | null>(null);
  const [lastGoodAt, setLastGoodAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const reload = useCallback(() => {
    if (!url) return;
    const mine = ++seq.current;
    setLoading(true);
    fetch(url, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(res.status === 401 ? "Signed out." : `HTTP ${res.status}`);
        return (await res.json()) as T;
      })
      .then((json) => {
        if (mine !== seq.current) return;
        setData(json);
        setLastGoodAt(Date.now());
        setError(null);
      })
      .catch((err: unknown) => {
        if (mine !== seq.current) return;
        setError(err instanceof Error && err.message ? err.message : "Can't reach the gateway.");
      })
      .finally(() => {
        if (mine === seq.current) setLoading(false);
      });
  }, [url]);

  useEffect(() => {
    // A different panel/item: drop the old payload so it never shows under the new heading.
    setData(null);
    setLastGoodAt(null);
    setError(null);
  }, [url]);

  useEffect(reload, [reload, rev]);

  useEffect(() => {
    const onVis = () => document.visibilityState === "visible" && reload();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  }, [reload]);

  return { data, lastGoodAt, error, loading, reload };
}
