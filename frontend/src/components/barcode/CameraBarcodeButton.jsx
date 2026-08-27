import { lazy, Suspense, useState } from "react";
import { Icon } from "../ui";
import { supportsCamera } from "../../utils/barcode";
import "./barcode-scanner.css";

// @zxing/browser is ~430 KB minified. Loading the modal lazily keeps it out of
// every page chunk that merely renders a camera button, so it is fetched only
// once someone actually opens the camera.
const BarcodeScannerModal = lazy(() => import("./BarcodeScannerModal"));

const loadingFallback = (
  <div className="barcode-scanner-backdrop" dir="rtl" lang="ar">
    <div className="barcode-scanner-modal">
      <div className="barcode-scanner-viewport">
        <div className="barcode-scanner-loading">جاري تشغيل الكاميرا…</div>
      </div>
    </div>
  </div>
);

export default function CameraBarcodeButton({
  onScan,
  disabled = false,
  ariaLabel = "مسح بالكاميرا",
  title = "مسح الباركود",
}) {
  const [open, setOpen] = useState(false);

  if (!supportsCamera()) return null;

  return (
    <>
      <button
        type="button"
        className="barcode-camera-btn"
        onClick={() => setOpen(true)}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
      >
        <Icon name="camera" size={20} />
      </button>
      {open ? (
        <Suspense fallback={loadingFallback}>
          <BarcodeScannerModal
            open
            onClose={() => setOpen(false)}
            onScan={(code) => {
              setOpen(false);
              onScan?.(code);
            }}
            title={title}
          />
        </Suspense>
      ) : null}
    </>
  );
}
