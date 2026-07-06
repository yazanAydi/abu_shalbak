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

const BARCODE_STATUS_COLOR = {
  free: "var(--office-success, #059669)",
  self: "#b45309",
  conflict: "var(--office-danger)",
  invalid: "var(--office-text-muted)",
};

function useBarcodeCheck(productId, barcode, excludeUnitId) {
  const [check, setCheck] = useState(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const code = normalizeBarcode(barcode);
    if (!productId || !code) {
      setCheck(null);
      setChecking(false);
      return undefined;
    }

    setChecking(true);
    const timer = window.setTimeout(async () => {
      try {
        const params = { barcode: code, product_id: productId };
        if (excludeUnitId) params.unit_id = excludeUnitId;
        const { data } = await api.get("/api/products/barcode-check", {
          headers: getAuthHeaders(),
          params,
        });
        setCheck(data);
      } catch {
        setCheck(null);
      } finally {
        setChecking(false);
      }
    }, 400);

    return () => window.clearTimeout(timer);
  }, [productId, barcode, excludeUnitId]);

  const blocked =
    check?.status === "conflict" ||
    check?.status === "self" ||
    check?.status === "invalid";

  return { check, checking, blocked };
}

function BarcodeStatusLine({ check, checking }) {
  if (checking) {
    return (
      <span className="ui-field__hint" style={{ color: "var(--office-text-muted)" }}>
        جاري التحقق…
      </span>
    );
  }
  if (!check?.status || check.status === "free") {
    if (!check) return null;
    return (
      <span className="ui-field__hint" style={{ color: BARCODE_STATUS_COLOR.free }}>
        {check.message || "الباركود متاح"}
      </span>
    );
  }
  return (
    <span className="ui-field__hint" style={{ color: BARCODE_STATUS_COLOR[check.status] }}>
      {check.message}
    </span>
  );
}

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
    purchase_enabled: true,
    is_default_purchase: false,
    sale_enabled: true,
  });
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const addBarcodeCheck = useBarcodeCheck(productId, newUnit.barcode, null);
  const editBarcodeCheck = useBarcodeCheck(
    productId,
    editForm?.barcode ?? "",
    editId
  );

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
    if (!productId || addBarcodeCheck.blocked) return;
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
          purchase_enabled: newUnit.purchase_enabled,
          is_default_purchase: newUnit.is_default_purchase,
          sale_enabled: newUnit.sale_enabled,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setNewUnit({ unit_name: "", barcode: "", price: "", cost: "", conversion_to_base: "1", purchase_enabled: true, is_default_purchase: false, sale_enabled: true });
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
      purchase_enabled: unit.purchase_enabled !== false,
      is_default_purchase: unit.is_default_purchase === true,
      sale_enabled: unit.sale_enabled !== false,
    });
  }

  async function saveEdit() {
    if (!productId || !editId || !editForm || editBarcodeCheck.blocked) return;
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
          purchase_enabled: editForm.purchase_enabled,
          is_default_purchase: editForm.is_default_purchase,
          sale_enabled: editForm.sale_enabled,
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
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <Input
                    value={editForm.barcode}
                    onChange={(e) => setEditForm({ ...editForm, barcode: e.target.value })}
                    placeholder="باركود"
                  />
                  <BarcodeStatusLine check={editBarcodeCheck.check} checking={editBarcodeCheck.checking} />
                </div>
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
                <div style={{ display: "flex", flexDirection: "column", gap: "0.15rem" }}>
                  <Input
                    type="number"
                    step="1"
                    min="0.0001"
                    value={editForm.conversion_to_base}
                    onChange={(e) => setEditForm({ ...editForm, conversion_to_base: e.target.value })}
                    placeholder="معامل التحويل"
                    title="عدد الحبات في الوحدة (مثلاً 12 للصندوق)"
                  />
                  <span style={{ fontSize: "0.72rem", color: "var(--office-text-muted)" }}>
                    1 {editForm.unit_name || "وحدة"} = {Number(editForm.conversion_to_base) || 1} حبة
                  </span>
                </div>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <input
                    type="checkbox"
                    checked={editForm.is_default}
                    onChange={(e) => setEditForm({ ...editForm, is_default: e.target.checked })}
                  />
                  افتراضي
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <input
                    type="checkbox"
                    checked={editForm.purchase_enabled}
                    onChange={(e) => setEditForm({ ...editForm, purchase_enabled: e.target.checked })}
                  />
                  شراء
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <input
                    type="checkbox"
                    checked={editForm.is_default_purchase}
                    onChange={(e) => setEditForm({ ...editForm, is_default_purchase: e.target.checked })}
                  />
                  افتراضي للشراء
                </label>
                <label style={{ display: "flex", alignItems: "center", gap: "0.25rem" }}>
                  <input
                    type="checkbox"
                    checked={editForm.sale_enabled}
                    onChange={(e) => setEditForm({ ...editForm, sale_enabled: e.target.checked })}
                  />
                  متاح للبيع (كاشير)
                </label>
                <PrimaryButton
                  type="button"
                  disabled={busy || editBarcodeCheck.blocked}
                  onClick={saveEdit}
                >
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
                {u.is_default_purchase ? (
                  <span className="product-barcodes-primary-badge">افتراضي للشراء</span>
                ) : null}
                {u.purchase_enabled === false ? (
                  <span style={{ color: "var(--office-text-muted)", fontSize: "0.8rem" }}>لا يُشترى</span>
                ) : null}
                {u.sale_enabled === false ? (
                  <span style={{ color: "var(--office-text-muted)", fontSize: "0.8rem" }}>لا يُباع بالكاشير</span>
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
          <BarcodeStatusLine check={addBarcodeCheck.check} checking={addBarcodeCheck.checking} />
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
          <span className="ui-field__hint">
            1 {newUnit.unit_name.trim() || "وحدة"} = {Number(newUnit.conversion_to_base) || 1} حبة
          </span>
        </FormField>
        <FormField label="الشراء">
          <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <input
              type="checkbox"
              checked={newUnit.purchase_enabled}
              onChange={(e) => setNewUnit({ ...newUnit, purchase_enabled: e.target.checked })}
            />
            متاحة للشراء
          </label>
        </FormField>
        <FormField label="افتراضي للشراء">
          <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <input
              type="checkbox"
              checked={newUnit.is_default_purchase}
              onChange={(e) => setNewUnit({ ...newUnit, is_default_purchase: e.target.checked })}
            />
            الوحدة الافتراضية للشراء
          </label>
        </FormField>
        <FormField label="البيع">
          <label style={{ display: "flex", alignItems: "center", gap: "0.35rem" }}>
            <input
              type="checkbox"
              checked={newUnit.sale_enabled}
              onChange={(e) => setNewUnit({ ...newUnit, sale_enabled: e.target.checked })}
            />
            متاح للبيع (كاشير)
          </label>
        </FormField>
        <PrimaryButton
          type="button"
          disabled={busy || addBarcodeCheck.blocked}
          onClick={addUnit}
        >
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
