import { useState } from "react";
import { Icon } from "../ui";
import { supportsCamera } from "../../utils/barcode";
import BarcodeScannerModal from "./BarcodeScannerModal";
import "./barcode-scanner.css";

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
      <BarcodeScannerModal
        open={open}
        onClose={() => setOpen(false)}
        onScan={(code) => {
          setOpen(false);
          onScan?.(code);
        }}
        title={title}
      />
    </>
  );
}
