import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { todayISO, qty as fmtQty } from "../../utils/format";
import { displayProductSku } from "../../utils/entityCodeDisplay";
import { useSubmitGuard } from "../../hooks/useSubmitGuard";
import ProductPicker from "../../components/ProductPicker";
import { fetchProductUnits } from "../Purchases";
import {
  PageHeader,
  Button,
  FormField,
  FormGrid,
  Input,
  Select,
  Textarea,
  SectionTitle,
  useToast,
} from "../../components/ui";
import { docConfig, pickDefaultInventoryUnit, inventorySelectableUnits, lineBaseQuantity } from "./constants";

function unitConversion(units, unitId) {
  const unit = (units || []).find((u) => Number(u.id) === Number(unitId));
  return unit ? Number(unit.conversion_to_base) || 1 : 1;
}

function unitName(units, unitId) {
  const unit = (units || []).find((u) => Number(u.id) === Number(unitId));
  return unit?.unit_name || "";
}

function baseUnitName(units) {
  const base = (units || []).find((u) => Number(u.conversion_to_base) === 1);
  return base?.unit_name || units?.[0]?.unit_name || "";
}

export default function InventoryDocumentForm({ docType }) {
  const cfg = docConfig(docType);
  const toast = useToast();
  const navigate = useNavigate();
  const guardSubmit = useSubmitGuard();
  const [documentDate, setDocumentDate] = useState(todayISO());
  const [reason, setReason] = useState(cfg.defaultReason);
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [draft, setDraft] = useState({
    product: null,
    units: [],
    unitId: null,
    quantity: "",
  });

  const draftBase = useMemo(() => {
    if (!draft.product || !draft.unitId) return 0;
    return lineBaseQuantity(draft.quantity, unitConversion(draft.units, draft.unitId));
  }, [draft]);

  const issueWarnings = useMemo(() => {
    if (cfg.type !== "issue") return [];
    const byProduct = new Map();
    for (const line of lines) {
      const prev = byProduct.get(line.product_id) || { name: line.product_name, stock: line.stock, out: 0 };
      prev.out += Number(line.base_quantity) || 0;
      byProduct.set(line.product_id, prev);
    }
    const warnings = [];
    for (const [, info] of byProduct) {
      const remaining = Number(info.stock) - info.out;
      if (remaining < 0) {
        warnings.push(`${info.name}: المخزون سيصبح ${fmtQty(remaining)}`);
      }
    }
    return warnings;
  }, [cfg.type, lines]);

  async function onPickProduct(product) {
    const units = inventorySelectableUnits(await fetchProductUnits(product.id));
    const def = pickDefaultInventoryUnit(units);
    setDraft({
      product,
      units,
      unitId: def?.id ?? null,
      quantity: "",
    });
  }

  function addDraftLine() {
    if (!draft.product) {
      toast.error("اختر منتجاً أولاً");
      return;
    }
    if (!draft.unitId) {
      toast.error("الوحدة مطلوبة");
      return;
    }
    const qty = Number(draft.quantity);
    if (!Number.isFinite(qty) || qty <= 0) {
      toast.error("الكمية يجب أن تكون أكبر من صفر");
      return;
    }
    const conversion = unitConversion(draft.units, draft.unitId);
    const baseQty = lineBaseQuantity(qty, conversion);
    const name = unitName(draft.units, draft.unitId);
    setLines((prev) => [
      ...prev,
      {
        key: `${draft.product.id}-${draft.unitId}-${Date.now()}`,
        product_id: draft.product.id,
        product_unit_id: draft.unitId,
        product_name: draft.product.name,
        sku: draft.product.sku,
        barcode: draft.product.barcode,
        unit_name: name,
        quantity: qty,
        conversion_to_base: conversion,
        base_quantity: baseQty,
        base_unit_name: baseUnitName(draft.units),
        stock: Number(draft.product.stock) || 0,
      },
    ]);
    setDraft({ product: null, units: [], unitId: null, quantity: "" });
  }

  function removeLine(key) {
    setLines((prev) => prev.filter((l) => l.key !== key));
  }

  function save() {
    return guardSubmit(async () => {
      if (!reason) {
        toast.error("السبب مطلوب");
        return;
      }
      if (lines.length === 0) {
        toast.error("يجب إضافة صنف واحد على الأقل");
        return;
      }
      setSaving(true);
      try {
        const { data } = await api.post(
          cfg.apiBase,
          {
            document_date: documentDate,
            reason,
            notes,
            items: lines.map((l) => ({
              product_id: l.product_id,
              product_unit_id: l.product_unit_id,
              quantity: l.quantity,
            })),
          },
          { headers: getAuthHeaders() }
        );
        toast.success("تم حفظ السند");
        navigate(`${cfg.pathBase}/${data.id}`);
      } catch (e) {
        toast.error(e.response?.data?.error || "فشل حفظ السند");
      } finally {
        setSaving(false);
      }
    });
  }

  const selectedUnit = (draft.units || []).find((u) => Number(u.id) === Number(draft.unitId));

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="inventory"
        title={cfg.title}
        actions={
          <Button variant="secondary" onClick={() => navigate(cfg.pathBase)}>
            رجوع
          </Button>
        }
      />

      <FormGrid>
        <FormField label="التاريخ" required>
          <Input type="date" value={documentDate} onChange={(e) => setDocumentDate(e.target.value)} />
        </FormField>
        <FormField label={cfg.type === "issue" ? "سبب الإخراج" : "سبب الإدخال"} required>
          <Select value={reason} onChange={(e) => setReason(e.target.value)}>
            {cfg.reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.labelAr}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="ملاحظات">
          <Textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} />
        </FormField>
      </FormGrid>

      <SectionTitle>إضافة المنتجات</SectionTitle>
      <FormGrid>
        <FormField label="المنتج">
          <ProductPicker
            onPick={onPickProduct}
            placeholder="ابحث عن المنتج بالاسم أو الرقم أو الباركود..."
            showIdentity
          />
          {draft.product ? (
            <span className="ui-field__hint">
              {draft.product.name} — الرقم {displayProductSku(draft.product.sku)} — الباركود{" "}
              {draft.product.barcode || "—"}
            </span>
          ) : null}
        </FormField>
        <FormField label="الوحدة">
          <Select
            value={draft.unitId || ""}
            onChange={(e) => setDraft((p) => ({ ...p, unitId: e.target.value ? Number(e.target.value) : null }))}
            disabled={!draft.product}
          >
            <option value="">—</option>
            {draft.units.map((u) => (
              <option key={u.id} value={u.id}>
                {u.unit_name} (×{Number(u.conversion_to_base) || 1})
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="الكمية">
          <Input
            type="number"
            min="0"
            step="0.001"
            value={draft.quantity}
            onChange={(e) => setDraft((p) => ({ ...p, quantity: e.target.value }))}
            disabled={!draft.product}
          />
        </FormField>
        <FormField label="الكمية الأساسية">
          <Input
            readOnly
            value={
              draft.product && draft.unitId && Number(draft.quantity) > 0
                ? `${fmtQty(draftBase)} ${baseUnitName(draft.units) || selectedUnit?.unit_name || ""}`
                : ""
            }
          />
        </FormField>
      </FormGrid>
      <div className="ui-toolbar" style={{ marginTop: "0.5rem" }}>
        <Button type="button" variant="secondary" onClick={addDraftLine}>
          إضافة منتج
        </Button>
      </div>

      <SectionTitle>المنتجات</SectionTitle>
      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              <th>المنتج</th>
              <th>الرقم</th>
              <th>الباركود</th>
              <th>الوحدة</th>
              <th>الكمية</th>
              <th>التحويل</th>
              <th>الكمية الأساسية</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {lines.length === 0 ? (
              <tr>
                <td colSpan={8}>لا توجد أصناف بعد</td>
              </tr>
            ) : (
              lines.map((l) => (
                <tr key={l.key}>
                  <td>{l.product_name}</td>
                  <td>{displayProductSku(l.sku)}</td>
                  <td>{l.barcode || "—"}</td>
                  <td>{l.unit_name}</td>
                  <td className="num">{fmtQty(l.quantity)}</td>
                  <td className="num">{fmtQty(l.conversion_to_base)}</td>
                  <td className="num">
                    {fmtQty(l.base_quantity)} {l.base_unit_name}
                  </td>
                  <td>
                    <Button variant="ghost" size="sm" onClick={() => removeLine(l.key)}>
                      حذف
                    </Button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {issueWarnings.length > 0 ? (
        <p className="pd-error-banner" style={{ marginTop: "0.75rem" }}>
          تنبيه: سيصبح المخزون سالباً ({issueWarnings.join("؛ ")}). يمكن حفظ السند.
        </p>
      ) : null}

      <div className="ui-toolbar" style={{ marginTop: "1rem" }}>
        <Button onClick={save} disabled={saving}>
          {saving ? "جاري الحفظ…" : "حفظ السند"}
        </Button>
      </div>
    </div>
  );
}
