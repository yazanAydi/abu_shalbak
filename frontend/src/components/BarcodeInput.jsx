import { useEffect, useRef, useState, useCallback } from "react";
import { lookupProductByBarcode } from "../utils/barcode";
import "./BarcodeInput.css";

export default function BarcodeInput({ onProductFound, onError }) {
  const [value, setValue] = useState("");
  const [err, setErr] = useState("");
  const inputRef = useRef(null);
  const errTimer = useRef(null);
  const onProductFoundRef = useRef(onProductFound);
  onProductFoundRef.current = onProductFound;

  const clearErrLater = useCallback(() => {
    if (errTimer.current) clearTimeout(errTimer.current);
    errTimer.current = setTimeout(() => setErr(""), 3000);
  }, []);

  useEffect(() => {
    inputRef.current?.focus();
    return () => {
      if (errTimer.current) clearTimeout(errTimer.current);
    };
  }, []);

  const search = useCallback(
    async (raw) => {
      try {
        const data = await lookupProductByBarcode(raw);
        onProductFoundRef.current?.(data);
        setValue("");
        setErr("");
        setTimeout(() => inputRef.current?.focus(), 0);
      } catch (e) {
        const msg = e.message || "تعذّر البحث";
        setErr(msg);
        onError?.(msg);
        clearErrLater();
        setValue("");
        setTimeout(() => inputRef.current?.focus(), 0);
      }
    },
    [onError, clearErrLater]
  );

  function onKeyDown(ev) {
    if (ev.key === "Enter") {
      ev.preventDefault();
      search(value);
    }
  }

  return (
    <div className="barcode-wrap">
      <label className="barcode-label">مسح الباركود</label>
      <input
        ref={inputRef}
        className="barcode-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="امسح الباركود أو اكتب الرقم ثم اضغط إدخال"
        autoComplete="off"
      />
      {err ? <div className="barcode-err">{err}</div> : null}
    </div>
  );
}
