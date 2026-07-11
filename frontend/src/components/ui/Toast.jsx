import { createContext, useCallback, useContext, useMemo, useState } from "react";
import Icon from "../icons/Icon";

const ToastContext = createContext(null);

let idSeq = 0;

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const dismiss = useCallback((id) => {
    setToasts((t) => t.filter((x) => x.id !== id));
  }, []);

  const push = useCallback(
    (message, type = "info", ttl = 3200) => {
      const id = ++idSeq;
      setToasts((t) => [...t, { id, message, type }]);
      if (ttl) setTimeout(() => dismiss(id), ttl);
      return id;
    },
    [dismiss]
  );

  const api = useMemo(
    () => ({
      show: push,
      success: (m, ttl) => push(m, "success", ttl),
      error: (m, ttl) => push(m, "error", ttl),
      info: (m, ttl) => push(m, "info", ttl),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="ui-toast-stack" dir="rtl">
        {toasts.map((t) => (
          <div key={t.id} className={`ui-toast ui-toast--${t.type}`} onClick={() => dismiss(t.id)}>
            <Icon name={t.type === "error" ? "alert" : t.type === "success" ? "check" : "inbox"} />
            <span>{t.message}</span>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) {
    // Safe no-op fallback so components work even outside a provider.
    return { show: () => {}, success: () => {}, error: () => {}, info: () => {} };
  }
  return ctx;
}
