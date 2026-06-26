import { useEffect, useRef, useState, useCallback } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { focusBarcodeInput } from "../utils/focusBarcodeInput";
import {
  beginProductNotFound,
  playProductNotFound,
  unlockPosAudio,
  warmPosSounds,
} from "../utils/posSounds";
import "./BarcodeInput.css";

const notFoundCache = new Set();

function normalizeBarcode(raw) {
  let t = String(raw ?? "")
    .trim()
    .replace(/[\u200B-\u200D\uFEFF\u200E\u200F]/g, "");
  t = t.replace(/[\u0660-\u0669]/g, (ch) =>
    String(ch.charCodeAt(0) - 0x0660)
  );
  t = t.replace(/[\u06F0-\u06F9]/g, (ch) =>
    String(ch.charCodeAt(0) - 0x06f0)
  );
  return t;
}

function isNotFoundError(e) {
  const status = e.response?.status;
  const apiError = e.response?.data?.error || e.message || "";
  return (
    status === 404 || /غير موجود|لم يُعثر|not found/i.test(String(apiError))
  );
}

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
      const code = normalizeBarcode(raw);
      if (!code) return;
      unlockPosAudio();
      warmPosSounds();

      const notFoundMsg = `لم يُعثر على المنتج (${code}) — أضفه من «إدارة المنتجات» أو جرّب 1234567890`;
      let cancelPendingError = null;

      if (notFoundCache.has(code)) {
        playProductNotFound();
        setErr(notFoundMsg);
        clearErrLater();
        setValue("");
        setTimeout(() => focusBarcodeInput(), 0);
        try {
          const { data } = await api.get(
            `/api/products/by-barcode/${encodeURIComponent(code)}`,
            { headers: { ...getAuthHeaders() } }
          );
          notFoundCache.delete(code);
          setErr("");
          onProductFoundRef.current?.(data);
        } catch (e) {
          if (!isNotFoundError(e)) {
            const apiError = e.response?.data?.error || e.message || "تعذّر البحث";
            setErr(apiError);
            onError?.(apiError);
            clearErrLater();
          }
        }
        return;
      }

      cancelPendingError = beginProductNotFound();

      try {
        const { data } = await api.get(
          `/api/products/by-barcode/${encodeURIComponent(code)}`,
          { headers: { ...getAuthHeaders() } }
        );
        cancelPendingError?.();
        onProductFoundRef.current?.(data);
        setValue("");
        setErr("");
        setTimeout(() => focusBarcodeInput(), 0);
      } catch (e) {
        const notFound = isNotFoundError(e);
        if (notFound) {
          notFoundCache.add(code);
        } else {
          cancelPendingError?.();
        }
        const msg = notFound
          ? notFoundMsg
          : e.response?.data?.error || e.message || "تعذّر البحث";
        setErr(msg);
        onError?.(msg);
        clearErrLater();
        setValue("");
        setTimeout(() => focusBarcodeInput(), 0);
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
