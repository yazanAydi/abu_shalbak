import { useEffect, useId, useRef } from "react";
import Icon from "../icons/Icon";
import { handleEnterNavKeyDown } from "../../utils/focusNavigation";

const FOCUSABLE =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

let lockCount = 0;
let previousOverflow = "";

function lockBody() {
  if (lockCount === 0 && typeof document !== "undefined") {
    previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
  }
  lockCount += 1;
}

function unlockBody() {
  lockCount = Math.max(0, lockCount - 1);
  if (lockCount === 0 && typeof document !== "undefined") {
    document.body.style.overflow = previousOverflow;
  }
}

function isEnabled(el) {
  return el && !el.hasAttribute("disabled");
}

function getInitialFocus(root) {
  if (!root) return null;
  const items = [...root.querySelectorAll(FOCUSABLE)].filter(isEnabled);
  const autofocus = root.querySelector("[autofocus]");
  if (isEnabled(autofocus)) return autofocus;
  const field = items.find((el) => /^(INPUT|SELECT|TEXTAREA)$/.test(el.tagName));
  return field || items[0] || root;
}

export default function Modal({
  open,
  title,
  description,
  onClose,
  children,
  footer,
  size,
  className,
}) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef(null);
  const previouslyFocused = useRef(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return undefined;
    lockBody();
    previouslyFocused.current = document.activeElement;
    const root = dialogRef.current;
    getInitialFocus(root)?.focus();

    const focusables = () =>
      [...(root?.querySelectorAll(FOCUSABLE) ?? [])].filter(isEnabled);

    const onKey = (e) => {
      if (e.key === "Escape") {
        onCloseRef.current?.();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (!items.length) {
        e.preventDefault();
        return;
      }
      const firstEl = items[0];
      const lastEl = items[items.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      unlockBody();
      previouslyFocused.current?.focus?.();
    };
  }, [open]);

  if (!open) return null;

  const sizeClass =
    size === "xl"
      ? "ui-modal--xl"
      : size === "lg"
        ? "ui-modal--lg"
        : size === "full"
          ? "ui-modal--full"
          : size === "sm"
            ? "ui-modal--sm"
            : "";

  return (
    <div className="ui-modal-overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div
        ref={dialogRef}
        className={["ui-modal", sizeClass, className].filter(Boolean).join(" ")}
        dir="rtl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
      >
        <div className="ui-modal__header">
          <div>
            <h3 id={titleId} className="ui-modal__title">
              {title}
            </h3>
            {description ? (
              <p id={descId} className="ui-modal__description">
                {description}
              </p>
            ) : null}
          </div>
          <button type="button" className="ui-modal__close" onClick={onClose} aria-label="إغلاق">
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="ui-modal__body" data-enter-nav="" onKeyDown={handleEnterNavKeyDown}>
          {children}
        </div>
        {footer && <div className="ui-modal__footer">{footer}</div>}
      </div>
    </div>
  );
}
