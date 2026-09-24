import { useEffect, useRef } from "react";
import { resolveApiUrl } from "../apiClient";
import { getToken, removeToken } from "../utils/auth";

/**
 * Authenticated SSE via fetch (EventSource cannot send Authorization).
 * Falls back silently if the stream is unavailable.
 */
export function useAuthEventSource(url, onEvent, { enabled = true } = {}) {
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;

  useEffect(() => {
    if (!enabled || !url) return undefined;
    const token = getToken();
    if (!token) return undefined;

    const controller = new AbortController();
    let cancelled = false;

    (async () => {
      try {
        const resolved = /^https?:\/\//i.test(url) ? url : resolveApiUrl(url);
        const res = await fetch(resolved, {
          headers: { Authorization: `Bearer ${token}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!res.ok || !res.body) return;
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (!cancelled) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const parts = buf.split("\n\n");
          buf = parts.pop() || "";
          for (const block of parts) {
            let event = "message";
            let data = "";
            for (const line of block.split("\n")) {
              if (line.startsWith("event:")) event = line.slice(6).trim();
              if (line.startsWith("data:")) data += line.slice(5).trim();
            }
            if (!data) continue;
            let parsed = data;
            try {
              parsed = JSON.parse(data);
            } catch {
              parsed = data;
            }
            if (event === "session" && (parsed?.code === "SESSION_REVOKED" || parsed?.code === "INVALID_TOKEN")) {
              removeToken();
              const loginPath = `${process.env.PUBLIC_URL || ""}/login`;
              if (!window.location.pathname.endsWith("/login")) {
                window.location.replace(`${loginPath}?session=expired`);
              }
              controller.abort();
              return;
            }
            onEventRef.current?.(event, parsed);
          }
        }
      } catch {
        /* aborted or offline */
      }
    })();

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, enabled]);
}
