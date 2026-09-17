import { useEffect, useId, useRef, useState } from "react";

export default function HelpTip({ children, label = "مساعدة" }) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    function onDoc(e) {
      if (!rootRef.current?.contains(e.target)) setOpen(false);
    }
    function onKey(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <span className="ui-help" ref={rootRef}>
      <button
        type="button"
        className="ui-help__btn"
        aria-label={label}
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((v) => !v)}
      >
        ?
      </button>
      {open ? (
        <span id={panelId} className="ui-help__panel" role="note">
          {children}
        </span>
      ) : null}
    </span>
  );
}
