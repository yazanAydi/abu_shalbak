import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export const OFFICE_PAGE_REFRESH_EVENT = "office:page-refresh";

const PageRefreshContext = createContext({
  refreshPage: null,
  registerRefresh: null,
  refreshing: false,
  pageKey: 0,
});

export function emitOfficePageRefresh() {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(OFFICE_PAGE_REFRESH_EVENT));
}

export function usePageRefresh() {
  return useContext(PageRefreshContext);
}

/** Register a loader so تحديث reloads this view instead of remounting the route. */
export function useRegisterPageRefresh(handler) {
  const { registerRefresh } = useContext(PageRefreshContext);
  useEffect(() => {
    if (!registerRefresh || !handler) return undefined;
    return registerRefresh(handler);
  }, [registerRefresh, handler]);
}

export function PageRefreshProvider({ children }) {
  const [pageKey, setPageKey] = useState(0);
  const [refreshing, setRefreshing] = useState(false);
  const handlersRef = useRef(new Set());
  const timerRef = useRef(null);

  const registerRefresh = useCallback((handler) => {
    handlersRef.current.add(handler);
    return () => {
      handlersRef.current.delete(handler);
    };
  }, []);

  const refreshPage = useCallback(async () => {
    emitOfficePageRefresh();
    const handlers = [...handlersRef.current];
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (handlers.length > 0) {
      setRefreshing(true);
      try {
        await Promise.all(handlers.map((fn) => Promise.resolve(fn())));
      } finally {
        setRefreshing(false);
      }
      return;
    }
    setRefreshing(true);
    setPageKey((k) => k + 1);
    timerRef.current = window.setTimeout(() => {
      setRefreshing(false);
      timerRef.current = null;
    }, 450);
  }, []);

  useEffect(
    () => () => {
      if (timerRef.current) window.clearTimeout(timerRef.current);
    },
    []
  );

  const value = useMemo(
    () => ({ refreshPage, registerRefresh, refreshing, pageKey }),
    [refreshPage, registerRefresh, refreshing, pageKey]
  );

  return <PageRefreshContext.Provider value={value}>{children}</PageRefreshContext.Provider>;
}

export { PageRefreshContext };
