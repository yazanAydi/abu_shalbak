import { useCallback, useEffect, useMemo, useState } from "react";
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
import UnitNameSelect from "../../components/UnitNameSelect";
import "./productBarcodes.css";

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function findBaseUnit(units, excludeId) {
  const list = excludeId ? units.filter((u) => u.id !== excludeId) : units;
  return (
    list.find((u) => Number(u.conversion_to_base) === 1) ||
    list.find((u) => u.is_default) ||
    list[0] ||
    null
  );
}

function autoCostFromBase(base, conversion) {
  if (!base) return "";
  const conv = Number(conversion);
  if (!Number.isFinite(conv) || conv <= 0) return "";
  return String(round2(Number(base.cost) * conv));
}

function costFromPieceHint(base, conversion) {
  if (!base) return "";
  const conv = Number(conversion) || 1;
  const piece = Number(base.cost) || 0;
  return `${conv} × ${ils(piece)} (${base.unit_name || "حبة"}) = ${ils(round2(piece * conv))}`;
}

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

function UnitFormFields({
  form,
  setForm,
  unitLabel,
  barcodeCheck,
  barcodeChecking,
  showCamera,
  showDefaultCheckbox,
  showAutoCost,
  baseUnit,
}) {
  const autoOn = Boolean(form.autoCost) && Boolean(showAutoCost) && Boolean(baseUnit);

  function setField(key, value) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  return (
    <>
      <div className="product-unit-form__grid">
        <FormField label={unitLabel}>
          <UnitNameSelect
            value={form.unit_name}
            onChange={(e) => setField("unit_name", e.target.value)}
          />
        </FormField>
        <FormField label="باركود">
          {showCamera ? (
            <div className="barcode-input-row">
              <Input
                value={form.barcode}
                onChange={(e) => setField("barcode", e.target.value)}
                placeholder="باركود الوحدة"
              />
              <CameraBarcodeButton onScan={(code) => setField("barcode", normalizeBarcode(code))} />
            </div>
          ) : (
            <Input
              value={form.barcode}
              onChange={(e) => setField("barcode", e.target.value)}
            />
          )}
          <BarcodeStatusLine check={barcodeCheck} checking={barcodeChecking} />
        </FormField>
        <FormField label="سعر البيع" hint="سعر هذه الوحدة للزبون — مستقل عن معامل التحويل">
          <Input
            type="number"
            step="0.01"
            value={form.price}
            onChange={(e) => setField("price", e.target.value)}
          />
        </FormField>
        <FormField label="التكلفة">
          <Input
            type="number"
            step="0.01"
            value={form.cost}
            readOnly={autoOn}
            disabled={autoOn}
            onChange={(e) => setField("cost", e.target.value)}
          />
          {showAutoCost && baseUnit ? (
            <>
              <label className="product-unit-form__auto">
                <input
                  type="checkbox"
                  checked={Boolean(form.autoCost)}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setForm((f) => ({
                      ...f,
                      autoCost: on,
                      cost: on ? autoCostFromBase(baseUnit, f.conversion_to_base) : f.cost,
                    }));
                  }}
                />
                احسب من {baseUnit.unit_name || "الوحدة الأساسية"}
              </label>
              {form.autoCost ? (
                <span className="ui-field__hint">{costFromPieceHint(baseUnit, form.conversion_to_base)}</span>
              ) : null}
            </>
          ) : null}
        </FormField>
        <FormField label="معامل التحويل إلى الوحدة الأساسية" className="ui-field--full">
          <Input
            type="number"
            step="0.001"
            min="0.0001"
            value={form.conversion_to_base}
            onChange={(e) => setField("conversion_to_base", e.target.value)}
          />
          <span className="ui-field__hint">
            1 {form.unit_name?.trim?.() || form.unit_name || "وحدة"} = {Number(form.conversion_to_base) || 1} {baseUnit?.unit_name || "وحدة أساسية"} — يحدد خصم المخزون فقط، وليس سعر البيع
          </span>
        </FormField>
      </div>
      <div className="product-unit-form__options">
        {showDefaultCheckbox ? (
          <label className="product-unit-form__option">
            <input
              type="checkbox"
              checked={Boolean(form.is_default)}
              onChange={(e) => setField("is_default", e.target.checked)}
            />
            افتراضي
          </label>
        ) : null}
        <label className="product-unit-form__option">
          <input
            type="checkbox"
            checked={form.purchase_enabled}
            onChange={(e) => setField("purchase_enabled", e.target.checked)}
          />
          متاحة للشراء
        </label>
        <label className="product-unit-form__option">
          <input
            type="checkbox"
            checked={form.is_default_purchase}
            onChange={(e) => setField("is_default_purchase", e.target.checked)}
          />
          افتراضي للشراء
        </label>
        <label className="product-unit-form__option">
          <input
            type="checkbox"
            checked={form.sale_enabled}
            onChange={(e) => setField("sale_enabled", e.target.checked)}
          />
          متاح للبيع (كاشير)
        </label>
      </div>
    </>
  );
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
    autoCost: true,
    purchase_enabled: true,
    is_default_purchase: false,
    sale_enabled: true,
  });
  const [editId, setEditId] = useState(null);
  const [editForm, setEditForm] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);

  const baseUnit = useMemo(() => findBaseUnit(units), [units]);
  const isEditingBase = editId != null && baseUnit?.id === editId;

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

  useEffect(() => {
    if (!newUnit.autoCost || !baseUnit) return;
    const next = autoCostFromBase(baseUnit, newUnit.conversion_to_base);
    setNewUnit((u) => (u.cost === next ? u : { ...u, cost: next }));
  }, [newUnit.autoCost, newUnit.conversion_to_base, baseUnit]);

  useEffect(() => {
    if (!editForm?.autoCost || isEditingBase || !baseUnit) return;
    const next = autoCostFromBase(baseUnit, editForm.conversion_to_base);
    setEditForm((f) => (f && f.cost === next ? f : { ...f, cost: next }));
  }, [editForm?.autoCost, editForm?.conversion_to_base, baseUnit, isEditingBase]);

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
      setNewUnit({
        unit_name: "",
        barcode: "",
        price: "",
        cost: "",
        conversion_to_base: "1",
        autoCost: Boolean(baseUnit),
        purchase_enabled: true,
        is_default_purchase: false,
        sale_enabled: true,
      });
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
      autoCost: false,
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
        {units.map((u) => {
          const base = findBaseUnit(units, u.id);
          const baseName = base?.unit_name || "وحدة";
          return (
          <li key={u.id} className="product-unit-row">
            <div className="product-unit-row__main">
              <div className="product-unit-row__id">
                <strong>{u.unit_name}</strong>
                <code>{u.barcode}</code>
              </div>
              <div className="product-unit-row__meta">
                <span>{ils(u.price)}</span>
                <span>×{u.conversion_to_base} {baseName}</span>
                {u.is_default ? (
                  <span className="product-barcodes-primary-badge">افتراضي</span>
                ) : null}
                {u.is_default_purchase ? (
                  <span className="product-barcodes-primary-badge">افتراضي للشراء</span>
                ) : null}
                {u.purchase_enabled === false ? (
                  <span style={{ fontSize: "0.8rem" }}>لا يُشترى</span>
                ) : null}
                {u.sale_enabled === false ? (
                  <span style={{ fontSize: "0.8rem" }}>لا يُباع بالكاشير</span>
                ) : null}
              </div>
              <div className="product-unit-row__actions">
                <SecondaryButton type="button" disabled={busy} onClick={() => startEdit(u)}>
                  تعديل
                </SecondaryButton>
                <SecondaryButton type="button" disabled={busy} onClick={() => removeUnit(u.id)}>
                  حذف
                </SecondaryButton>
              </div>
            </div>
            {editId === u.id && editForm ? (
              <div className="product-unit-form">
                <UnitFormFields
                  form={editForm}
                  setForm={setEditForm}
                  unitLabel="الوحدة"
                  barcodeCheck={editBarcodeCheck.check}
                  barcodeChecking={editBarcodeCheck.checking}
                  showCamera={false}
                  showDefaultCheckbox
                  showAutoCost={!isEditingBase}
                  baseUnit={baseUnit}
                />
                <div className="product-unit-form__actions">
                  <PrimaryButton
                    type="button"
                    disabled={busy || editBarcodeCheck.blocked}
                    onClick={saveEdit}
                  >
                    حفظ
                  </PrimaryButton>
                  <SecondaryButton type="button" disabled={busy} onClick={() => { setEditId(null); setEditForm(null); }}>
                    إلغاء
                  </SecondaryButton>
                </div>
              </div>
            ) : null}
          </li>
          );
        })}
      </ul>

      {!editId ? (
        <div className="product-unit-form">
          <UnitFormFields
            form={newUnit}
            setForm={setNewUnit}
            unitLabel="وحدة جديدة"
            barcodeCheck={addBarcodeCheck.check}
            barcodeChecking={addBarcodeCheck.checking}
            showCamera
            showDefaultCheckbox={false}
            showAutoCost={Boolean(baseUnit)}
            baseUnit={baseUnit}
          />
          <div className="product-unit-form__actions">
            <PrimaryButton
              type="button"
              disabled={busy || addBarcodeCheck.blocked}
              onClick={addUnit}
            >
              إضافة وحدة
            </PrimaryButton>
          </div>
        </div>
      ) : null}

      {err ? (
        <p style={{ color: "var(--office-danger)", marginBottom: 0, marginTop: "0.75rem" }}>
          {err}
        </p>
      ) : null}
    </div>
  );
}
