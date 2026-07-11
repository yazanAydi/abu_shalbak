import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";

function unwrapData(body) {
  return body?.data ?? body;
}

/**
 * Polls office nav badge counts for the top navbar.
 * @returns {{ badgesByPath: Record<string, number>, total: number, loading: boolean, refresh: () => Promise<void> }}
 */
export default function useOfficeNavBadges(enabled = true) {
  const [badgesByPath, setBadgesByPath] = useState({});
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setBadgesByPath({});
      setTotal(0);
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get("/api/office/nav-badges", {
        headers: getAuthHeaders(),
      });
      const payload = unwrapData(data);
      setBadgesByPath(payload?.by_path ?? {});
      setTotal(Number(payload?.total) || 0);
    } catch {
      setBadgesByPath({});
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
    if (!enabled) return undefined;
    const timer = window.setInterval(refresh, 60_000);
    return () => window.clearInterval(timer);
  }, [refresh, enabled]);

  return { badgesByPath, total, loading, refresh };
}

/**
 * Sum badge counts for visible nav items in a section.
 * @param {Array<{ path: string, badgePath?: string }>} items
 * @param {Record<string, number>} badgesByPath
 */
export function sumSectionBadgeCount(items, badgesByPath) {
  let sum = 0;
  const seen = new Set();
  for (const item of items) {
    const key = item.badgePath ?? item.path;
    if (seen.has(key)) continue;
    seen.add(key);
    sum += Number(badgesByPath[key]) || 0;
  }
  return sum;
}

/**
 * Badge count for a single nav item.
 * @param {{ path: string, badgePath?: string }} item
 * @param {Record<string, number>} badgesByPath
 */
export function navItemBadgeCount(item, badgesByPath) {
  const key = item.badgePath ?? item.path;
  return Number(badgesByPath[key]) || 0;
}
