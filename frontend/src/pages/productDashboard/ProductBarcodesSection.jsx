import { useCallback, useEffect, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { normalizeBarcode } from "../../utils/barcode";
import CameraBarcodeButton from "../../components/barcode/CameraBarcodeButton";
import {
  FormField,
  Input,
  PrimaryButton,
  SecondaryButton,
} from "../../components/ui";
import "./productBarcodes.css";

/**
 * @param {{ productId: number | null, onChanged?: () => void }} props
 */
export default function ProductBarcodesSection({ productId, onChanged }) {
  const [barcodes, setBarcodes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newBarcode, setNewBarcode] = useState("");
  const [newLabel, setNewLabel] = useState("");
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!productId) {
      setBarcodes([]);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get(`/api/products/${productId}/barcodes`, {
        headers: getAuthHeaders(),
      });
      setBarcodes(Array.isArray(data.barcodes) ? data.barcodes : []);
      setErr(null);
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    load();
  }, [load]);

  async function addBarcode() {
    if (!productId) return;
    const code = normalizeBarcode(newBarcode);
    if (!code) {
      setErr("أدخل باركوداً صالحاً");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.post(
        `/api/products/${productId}/barcodes`,
        { barcode: code, label: newLabel.trim() || null },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setNewBarcode("");
      setNewLabel("");
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر إضافة الباركود");
    } finally {
      setBusy(false);
    }
  }

  async function removeBarcode(barcodeId) {
    if (!productId || !window.confirm("حذف الباركود؟")) return;
    setBusy(true);
    setErr(null);
    try {
      await api.delete(`/api/products/${productId}/barcodes/${barcodeId}`, {
        headers: getAuthHeaders(),
      });
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function setPrimary(barcodeId) {
    if (!productId) return;
    setBusy(true);
    setErr(null);
    try {
      await api.patch(
        `/api/products/${productId}/barcodes/${barcodeId}/primary`,
        {},
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!productId) return null;

  return (
    <div className="product-barcodes-section" dir="rtl" lang="ar">
      <h3 style={{ margin: 0, fontSize: "1rem" }}>الباركودات</h3>
      {loading ? <p style={{ color: "var(--office-text-muted)" }}>جاري التحميل…</p> : null}
      {!loading && barcodes.length === 0 ? (
        <p style={{ color: "var(--office-text-muted)", marginBottom: 0 }}>لا توجد باركودات.</p>
      ) : null}
      <ul className="product-barcodes-list">
        {barcodes.map((b) => (
          <li key={b.id} className="product-barcodes-item">
            <code>{b.barcode}</code>
            {b.label ? <span style={{ color: "var(--office-text-muted)" }}>({b.label})</span> : null}
            {Number(b.is_primary) === 1 ? (
              <span className="product-barcodes-primary-badge">الباركود الأساسي</span>
            ) : (
              <SecondaryButton type="button" disabled={busy} onClick={() => setPrimary(b.id)}>
                تعيين كأساسي
              </SecondaryButton>
            )}
            <SecondaryButton type="button" disabled={busy} onClick={() => removeBarcode(b.id)}>
              حذف الباركود
            </SecondaryButton>
          </li>
        ))}
      </ul>

      <div className="product-barcodes-add-row">
        <FormField label="باركود جديد">
          <div className="barcode-input-row">
            <Input
              value={newBarcode}
              onChange={(e) => setNewBarcode(e.target.value)}
              placeholder="أدخل الباركود"
            />
            <CameraBarcodeButton onScan={(code) => setNewBarcode(normalizeBarcode(code))} />
          </div>
        </FormField>
        <FormField label="تسمية (اختياري)">
          <Input
            value={newLabel}
            onChange={(e) => setNewLabel(e.target.value)}
            placeholder="علبة، كرتونة…"
          />
        </FormField>
        <PrimaryButton type="button" disabled={busy} onClick={addBarcode}>
          إضافة باركود
        </PrimaryButton>
      </div>

      {err ? (
        <p style={{ color: "var(--office-danger)", marginBottom: 0, marginTop: "0.75rem" }}>
          {err}
        </p>
      ) : null}
    </div>
  );
}
