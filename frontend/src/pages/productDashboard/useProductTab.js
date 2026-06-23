import { useEffect, useState } from "react";
import api from "../../apiClient";

/**
 * Lazy fetch helper for a single Product 360 tab. Fetches once on mount
 * (so data only loads when the tab is first opened) and exposes loading/error.
 */
export function useProductTab(url) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api
      .get(url)
      .then((r) => {
        if (!alive) return;
        setData(r.data);
        setError(null);
      })
      .catch((e) => {
        if (!alive) return;
        setError(e.message || "تعذّر تحميل البيانات");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [url]);

  return { data, loading, error };
}
