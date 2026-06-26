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

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {{ productId: number | null, onChanged?: () => void }} props
 */
export default function ProductUnitsSection({ productId, onChanged }) {
  const [units, setUnits] = useState([]);
  const [loading, setLoading] = useState(false);
  const [newUnit, setNewUnit] = useState({
    unit_name: "",
    barcode: "",
    price: "",
    cost: "",
    conversion_to_base: "1",
  });
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!productId) {
      setUnits([]);
      return;
    }
    setLoading(true);
    try {
      const { data } = await api.get(`/api/products/${productId}/units`, {
        headers: getAuthHeaders(),
      });
      setUnits(Array.isArray(data.units) ? data.units : []);
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

  async function addUnit() {
    if (!productId) return;
    const code = normalizeBarcode(newUnit.barcode);
    if (!code) {
      setErr("أدخل باركوداً صالحاً");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.post(
        `/api/products/${productId}/units`,
        {
          unit_name: newUnit.unit_name.trim() || "حبة",
          barcode: code,
          price: newUnit.price === "" ? 0 : Number(newUnit.price),
          cost: newUnit.cost === "" ? 0 : Number(newUnit.cost),
          conversion_to_base: Number(newUnit.conversion_to_base) || 1,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setNewUnit({ unit_name: "", barcode: "", price: "", cost: "", conversion_to_base: "1" });
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || e.message || "تعذّر إضافة الوحدة");
    } finally {
      setBusy(false);
    }
  }

  function startEdit(unit) {
    setEditId(unit.id);
    setEditForm({
      unit_name: unit.unit_name,
      barcode: unit.barcode,
      price: String(unit.price),
      cost: String(unit.cost),
      conversion_to_base: String(unit.conversion_to_base),
      is_default: unit.is_default,
    });
  }

  async function saveEdit() {
    if (!productId || !editId || !editForm) return;
    setBusy(true);
    setErr(null);
    try {
      await api.put(
        `/api/products/${productId}/units/${editId}`,
        {
          unit_name: editForm.unit_name.trim() || "حبة",
          barcode: normalizeBarcode(editForm.barcode),
          price: Number(editForm.price),
          cost: Number(editForm.cost),
          conversion_to_base: Number(editForm.conversion_to_base) || 1,
          is_default: editForm.is_default,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setEditId(null);
      setEditForm(null);
      await load();
      onChanged?.();
    } catch (e) {
      setErr(e.response?.data?.error || e.message);
    } finally {
      setBusy(false);
    }
  }

  async function removeUnit(unitId) {
    if (!productId || !window.confirm("حذف الوحدة؟")) return;
    setBusy(true);
    setErr(null);
    try {
      await api.delete(`/api/products/${productId}/units/${unitId}`, {
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

  if (!productId) return null;

  return (
    <div className="product-barcodes-section" dir="rtl" lang="ar">
      <h3 style={{ margin: 0, fontSize: "1rem" }}>وحدات البيع</h3>
      {loading ? <p style={{ color: "var(--office-text-muted)" }}>جاري التحميل…</p> : null}
      {!loading && units.length === 0 ? (
        <p style={{ color: "var(--office-text-muted)", marginBottom: 0 }}>لا توجد وحدات.</p>
      ) : null}
      <ul className="product-barcodes-list">
        {units.map((u) => (
          <li key={u.id} className="product-barcodes-item" style={{ flexWrap: "wrap", gap: "0.5rem" }}>
            {editId === u.id && editForm ? (
              <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", width: "100%" }}>
                <Input
                  value={editForm.unit_name}
                  onChange={(e) => setEditForm({ ...editForm, unit_name: e.target.value })}
                  placeholder="اسم الوحدة"
                />
                <Input
                  value={editForm.barcode}
                  onChange={(e) => setEditForm({ ...editForm, barcode: e.target.value })}
                  placeholder="باركود"
                />
                <Input
                  type="number"
                  step="0.01"
                  value={editForm.price}
                  onChange={(e) => setEditForm({ ...editForm, price: e.target.value })}
                  placeholder="السعر"
                />
                <Input
                  type="number"
                  step="0.01"
                  value={editForm.cost}
                  onChange={(e) => setEditForm({ ...editForm, cost: e.target.value })}
                  placeholder="التكلفة"
                />
                <Input
                  type="number"
                  step="1"
                  min="0.0001"
                  value={editForm.conversion_to_base}
                  onChange={(e) => setEditForm({ ...editForm, conversion_to_base: e.target.value })}
                  placeholder="معامل التحويل"
                  title="عدد الحبات في الوحدة (مثلاً 12 للصندوق)"
                />
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <input
                    type="checkbox"
                    checked={editForm.is_default}
                    onChange={(e) => setEditForm({ ...editForm, is_default: e.target.checked })}
                  />
                  افتراضي
                </label>
                <PrimaryButton type="button" disabled={busy} onClick={saveEdit}>
                  حفظ
                </PrimaryButton>
                <SecondaryButton type="button" disabled={busy} onClick={() => setEditId(null)}>
                  إلغاء
                </SecondaryButton>
              </div>
            ) : (
              <>
                <strong>{u.unit_name}</strong>
                <code>{u.barcode}</code>
                <span>{ils(u.price)}</span>
                <span style={{ color: "var(--office-text-muted)" }}>
                  ×{u.conversion_to_base} حبة
                </span>
                {u.is_default ? (
                  <span className="product-barcodes-primary-badge">افتراضي</span>
                ) : null}
                <SecondaryButton type="button" disabled={busy} onClick={() => startEdit(u)}>
                  تعديل
                </SecondaryButton>
                <SecondaryButton type="button" disabled={busy} onClick={() => removeUnit(u.id)}>
                  حذف
                </SecondaryButton>
              </>
            )}
          </li>
        ))}
      </ul>

      <div className="product-barcodes-add-row">
        <FormField label="وحدة جديدة">
          <Input
            value={newUnit.unit_name}
            onChange={(e) => setNewUnit({ ...newUnit, unit_name: e.target.value })}
            placeholder="قنينة، صندوق…"
          />
        </FormField>
        <FormField label="باركود">
          <div className="barcode-input-row">
            <Input
              value={newUnit.barcode}
              onChange={(e) => setNewUnit({ ...newUnit, barcode: e.target.value })}
              placeholder="باركود الوحدة"
            />
            <CameraBarcodeButton onScan={(code) => setNewUnit({ ...newUnit, barcode: normalizeBarcode(code) })} />
          </div>
        </FormField>
        <FormField label="السعر">
          <Input
            type="number"
            step="0.01"
            value={newUnit.price}
            onChange={(e) => setNewUnit({ ...newUnit, price: e.target.value })}
          />
        </FormField>
        <FormField label="التكلفة">
          <Input
            type="number"
            step="0.01"
            value={newUnit.cost}
            onChange={(e) => setNewUnit({ ...newUnit, cost: e.target.value })}
          />
        </FormField>
        <FormField label="معامل التحويل (حبات/وحدة)">
          <Input
            type="number"
            step="1"
            min="0.0001"
            value={newUnit.conversion_to_base}
            onChange={(e) => setNewUnit({ ...newUnit, conversion_to_base: e.target.value })}
          />
        </FormField>
        <PrimaryButton type="button" disabled={busy} onClick={addUnit}>
          إضافة وحدة
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
