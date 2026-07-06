import { useEffect } from "react";
import Icon from "../icons/Icon";

export default function Modal({ open, title, onClose, children, footer, size }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="ui-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`ui-modal ${size === "lg" ? "ui-modal--lg" : ""}`} dir="rtl">
        <div className="ui-modal__header">
          <h3 className="ui-modal__title">{title}</h3>
          <button type="button" className="ui-modal__close" onClick={onClose} aria-label="إغلاق">
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="ui-modal__body">{children}</div>
        {footer && <div className="ui-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
