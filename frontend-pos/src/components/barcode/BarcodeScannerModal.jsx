import { useCallback, useEffect, useState } from "react";

import { Icon } from "../ui";

import { useCameraBarcode } from "./useCameraBarcode";

import "./barcode-scanner.css";

export default function BarcodeScannerModal({
  open,
  onClose,
  onScan,
  title = "مسح الباركود",
}) {
  const [err, setErr] = useState("");

  useEffect(() => {
    if (open) setErr("");
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const handleScan = useCallback(
    (code) => {
      onScan?.(code);
    },
    [onScan]
  );

  const { videoRef, starting } = useCameraBarcode({
    active: open,
    onScan: handleScan,
    onError: setErr,
  });

  // Scanning is automatic (no tap needed), so tapping anywhere on the
  // camera view acts as cancel. Buttons also call onClose; double calls
  // are harmless since they just close the modal.
  const handleBackdrop = useCallback(() => {
    onClose?.();
  }, [onClose]);

  if (!open) return null;

  return (
    <div
      className="barcode-scanner-backdrop"
      dir="rtl"
      lang="ar"
      role="dialog"
      aria-modal="true"
      aria-labelledby="barcode-scanner-title"
    >
      <div className="barcode-scanner-modal">
        <div className="barcode-scanner-viewport" onClick={handleBackdrop}>
          <video ref={videoRef} muted playsInline autoPlay />

          {!starting && !err ? (
            <div className="barcode-scanner-overlay" aria-hidden="true">
              <div className="barcode-scanner-frame">
                <span className="barcode-scanner-corner barcode-scanner-corner--tl" />
                <span className="barcode-scanner-corner barcode-scanner-corner--tr" />
                <span className="barcode-scanner-corner barcode-scanner-corner--bl" />
                <span className="barcode-scanner-corner barcode-scanner-corner--br" />
                <div className="barcode-scanner-line" />
              </div>
            </div>
          ) : null}

          <button
            type="button"
            className="barcode-scanner-close"
            onClick={onClose}
            aria-label="إغلاق"
          >
            <Icon name="close" size={26} />
          </button>

          <h2 id="barcode-scanner-title" className="barcode-scanner-title">
            {title}
          </h2>

          {starting ? (
            <div className="barcode-scanner-loading">جاري تشغيل الكاميرا…</div>
          ) : null}

          {!starting && !err ? (
            <div className="barcode-scanner-hint">وجّه الباركود داخل الإطار</div>
          ) : null}

          {err ? <div className="barcode-scanner-error">{err}</div> : null}

          <button
            type="button"
            className="barcode-scanner-cancel"
            onClick={onClose}
          >
            إلغاء
          </button>
        </div>
      </div>
    </div>
  );
}
