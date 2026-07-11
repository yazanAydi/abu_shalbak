import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { dateOnly } from "../utils/format";
import ProductPicker from "../components/ProductPicker";
import {
  PageHeader, Button, DataTable, Modal, Tabs, StatusPill,
  FormField, FormGrid, Input, Select, Textarea, ReportToolbar, useToast,
} from "../components/ui";
import { pickExportColumns } from "../utils/reportExport";

const OFFER_LABELS = {
  multi_price: "عرض: كمية بسعر",
  percentage: "خصم نسبة %",
  fixed: "خصم مبلغ ثابت",
  bundle: "حزمة",
  buy_x_get_y: "اشترِ X واحصل على Y",
};

const OFFER_TYPE_ORDER = ["multi_price", "percentage", "fixed", "bundle", "buy_x_get_y"];

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const emptyPromo = {
  campaign_id: "",
  name: "",
  offer_type: "multi_price",
  product_id: null,
  product_name: "",
  product_unit_id: "",
  category: "",
  discount_value: "",
  buy_qty: "",
  get_qty: "",
  min_amount: "",
  start_date: "",
  end_date: "",
  active: true,
  use_dates: false,
  use_limit_qty: false,
  limit_qty: "",
  stop_when_out_of_stock: false,
};

function promoToForm(p) {
  return {
    campaign_id: p.campaign_id ? String(p.campaign_id) : "",
    name: p.name || "",
    offer_type: p.offer_type || "percentage",
    product_id: p.product_id || null,
    product_name: p.product_name || "",
    product_unit_id: p.product_unit_id ? String(p.product_unit_id) : "",
    category: p.category || "",
    discount_value:
      p.discount_value != null
        ? p.offer_type === "multi_price"
          ? Number(p.discount_value).toFixed(2)
          : String(p.discount_value)
        : "",
    buy_qty: p.buy_qty != null ? String(p.buy_qty) : "",
    get_qty: p.get_qty != null ? String(p.get_qty) : "",
    min_amount: p.min_amount != null ? String(p.min_amount) : "",
    start_date: p.start_date || "",
    end_date: p.end_date || "",
    active: p.active !== 0,
    use_dates: !!(p.start_date || p.end_date),
    use_limit_qty: Number(p.limit_qty) > 0,
    limit_qty: p.limit_qty != null ? String(p.limit_qty) : "",
    stop_when_out_of_stock: Number(p.stop_when_out_of_stock) === 1,
  };
}

function formatPromoValue(p) {
  if (p.offer_type === "percentage") return `${p.discount_value}%`;
  if (p.offer_type === "buy_x_get_y") return `${p.buy_qty}+${p.get_qty}`;
  if (p.offer_type === "multi_price") return `${p.buy_qty} بـ ₪${Number(p.discount_value).toFixed(2)}`;
  return `₪${Number(p.discount_value).toFixed(2)}`;
}

function formatPromoTarget(p) {
  if (p.product_name) {
    return p.unit_name ? `${p.product_name} (${p.unit_name})` : p.product_name;
  }
  if (p.category) return `فئة: ${p.category}`;
  return "—";
}

function formatPromoEnd(p) {
  const parts = [];
  if (p.start_date || p.end_date) {
    parts.push(`${p.start_date ? dateOnly(p.start_date) : "—"} ← ${p.end_date ? dateOnly(p.end_date) : "—"}`);
  }
  if (Number(p.limit_qty) > 0) {
    parts.push(`المستخدم: ${Number(p.used_qty || 0)} / ${Number(p.limit_qty)}`);
  }
  if (Number(p.stop_when_out_of_stock) === 1) {
    parts.push("حتى نفاد المخزون");
  }
  return parts.length ? parts.join(" · ") : "—";
}

function isPromoExhausted(p) {
  return Number(p.limit_qty) > 0 && Number(p.used_qty || 0) >= Number(p.limit_qty);
}

function pickDefaultUnitId(units) {
  if (!Array.isArray(units) || units.length === 0) return "";
  const def = units.find((u) => Number(u.is_default) === 1) || units[0];
  return String(def.id);
}

export default function Marketing() {
  const toast = useToast();
  const [tab, setTab] = useState("promotions");
  const [campaigns, setCampaigns] = useState([]);
  const [promotions, setPromotions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [productUnits, setProductUnits] = useState([]);
  const [unitsLoading, setUnitsLoading] = useState(false);

  const [showCampaign, setShowCampaign] = useState(false);
  const [campaignForm, setCampaignForm] = useState({ name: "", description: "", start_date: "", end_date: "", active: true });

  const [showPromo, setShowPromo] = useState(false);
  const [editingPromoId, setEditingPromoId] = useState(null);
  const [promoForm, setPromoForm] = useState(emptyPromo);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [c, p] = await Promise.all([
        api.get("/api/marketing/campaigns", { headers: getAuthHeaders() }),
        api.get("/api/marketing/promotions", { headers: getAuthHeaders() }),
      ]);
      setCampaigns(c.data); setPromotions(p.data);
    } catch { toast.error("تعذّر التحميل"); } finally { setLoading(false); }
  }, [toast]);
  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (!promoForm.product_id) {
      setProductUnits([]);
      setUnitsLoading(false);
      return;
    }
    let cancelled = false;
    setUnitsLoading(true);
    (async () => {
      try {
        const res = await api.get(`/api/products/${promoForm.product_id}/units`, { headers: getAuthHeaders() });
        if (cancelled) return;
        const payload = res.data;
        const units = Array.isArray(payload?.units)
          ? payload.units
          : Array.isArray(payload)
            ? payload
            : [];
        setProductUnits(units);
        if (units.length > 0) {
          setPromoForm((f) => {
            const currentValid =
              f.product_unit_id && units.some((u) => String(u.id) === String(f.product_unit_id));
            if (currentValid) return f;
            return { ...f, product_unit_id: pickDefaultUnitId(units) };
          });
        }
      } catch {
        if (!cancelled) setProductUnits([]);
      } finally {
        if (!cancelled) setUnitsLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [promoForm.product_id]);

  async function saveCampaign() {
    if (!campaignForm.name.trim()) { toast.error("اسم الحملة مطلوب"); return; }
    try {
      await api.post("/api/marketing/campaigns", campaignForm, { headers: getAuthHeaders() });
      toast.success("تمت إضافة الحملة"); setShowCampaign(false);
      setCampaignForm({ name: "", description: "", start_date: "", end_date: "", active: true }); load();
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function removeCampaign(id) {
    if (!window.confirm("حذف الحملة؟")) return;
    try { await api.delete(`/api/marketing/campaigns/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); load(); }
    catch { toast.error("فشل"); }
  }
  async function toggleCampaign(c) {
    try { await api.put(`/api/marketing/campaigns/${c.id}`, { active: !c.active }, { headers: getAuthHeaders() }); load(); }
    catch { toast.error("فشل"); }
  }

  function openNewPromo() {
    setEditingPromoId(null);
    setPromoForm(emptyPromo);
    setShowPromo(true);
  }

  function openEditPromo(p) {
    setEditingPromoId(p.id);
    setPromoForm(promoToForm(p));
    setShowPromo(true);
  }

  function buildPromoPayload() {
    return {
      campaign_id: promoForm.campaign_id || null,
      name: promoForm.name,
      offer_type: promoForm.offer_type,
      product_id: promoForm.product_id,
      product_unit_id: promoForm.product_id && promoForm.product_unit_id ? Number(promoForm.product_unit_id) : null,
      category: promoForm.product_id ? "" : promoForm.category,
      discount_value: round2(Number(promoForm.discount_value) || 0),
      buy_qty: Number(promoForm.buy_qty) || 0,
      get_qty: Number(promoForm.get_qty) || 0,
      min_amount: promoForm.offer_type === "multi_price" ? 0 : (Number(promoForm.min_amount) || 0),
      start_date: promoForm.use_dates ? (promoForm.start_date || null) : null,
      end_date: promoForm.use_dates ? (promoForm.end_date || null) : null,
      limit_qty: promoForm.use_limit_qty ? (Number(promoForm.limit_qty) || 0) : 0,
      stop_when_out_of_stock: promoForm.stop_when_out_of_stock,
      active: promoForm.active,
    };
  }

  async function savePromo() {
    if (!promoForm.name.trim()) { toast.error("اسم العرض مطلوب"); return; }
    if (!promoForm.product_id && !promoForm.category.trim()) { toast.error("حدّد منتجاً أو فئة"); return; }
    if (promoForm.product_id && !promoForm.product_unit_id) {
      toast.error("حدّد وحدة المنتج"); return;
    }
    if (promoForm.use_limit_qty && !(Number(promoForm.limit_qty) > 0)) {
      toast.error("أدخل عدد الوحدات للحد الأقصى"); return;
    }
    if (promoForm.stop_when_out_of_stock && !promoForm.product_id) {
      toast.error("نفاد المخزون يتطلب تحديد منتج"); return;
    }
    if (promoForm.offer_type === "multi_price") {
      if (!(Number(promoForm.buy_qty) > 0)) { toast.error("أدخل الكمية"); return; }
      if (!(Number(promoForm.discount_value) > 0)) { toast.error("أدخل سعر البيع"); return; }
    }
    try {
      const payload = buildPromoPayload();
      let res;
      if (editingPromoId) {
        res = await api.put(`/api/marketing/promotions/${editingPromoId}`, payload, { headers: getAuthHeaders() });
        toast.success("تم تحديث العرض");
      } else {
        res = await api.post("/api/marketing/promotions", payload, { headers: getAuthHeaders() });
        toast.success("تمت إضافة العرض");
      }
      if (Number(res.data?.deactivated_sibling_count) > 0) {
        toast.info("تم تعطيل العروض السابقة لنفس المنتج والوحدة");
      }
      setShowPromo(false);
      setEditingPromoId(null);
      setPromoForm(emptyPromo);
      load();
    } catch (e) { toast.error(e.response?.data?.error || "فشل"); }
  }
  async function removePromo(id) {
    if (!window.confirm("حذف العرض؟")) return;
    try { await api.delete(`/api/marketing/promotions/${id}`, { headers: getAuthHeaders() }); toast.success("تم الحذف"); load(); }
    catch { toast.error("فشل"); }
  }
  async function togglePromo(p) {
    try { await api.put(`/api/marketing/promotions/${p.id}`, { active: !p.active }, { headers: getAuthHeaders() }); load(); }
    catch { toast.error("فشل"); }
  }

  const needsValue = ["percentage", "fixed", "bundle"].includes(promoForm.offer_type);
  const needsBxgy = promoForm.offer_type === "buy_x_get_y";
  const needsBundleQty = promoForm.offer_type === "bundle";
  const needsMultiPrice = promoForm.offer_type === "multi_price";

  const promoColumns = [
    { key: "name", header: "العرض", value: (p) => p.name, render: (p) => <strong>{p.name}</strong> },
    { key: "offer_type", header: "النوع", value: (p) => OFFER_LABELS[p.offer_type] || p.offer_type, render: (p) => OFFER_LABELS[p.offer_type] || p.offer_type },
    { key: "target", header: "النطاق", value: formatPromoTarget, render: (p) => formatPromoTarget(p) },
    {
      key: "value", header: "القيمة",
      value: formatPromoValue,
      render: (p) => formatPromoValue(p),
    },
    { key: "end", header: "انتهاء العرض", value: formatPromoEnd, render: (p) => formatPromoEnd(p) },
    { key: "campaign_name", header: "الحملة", value: (p) => p.campaign_name || "—", render: (p) => p.campaign_name || "—" },
    {
      key: "active",
      header: "الحالة",
      value: (p) => (isPromoExhausted(p) ? "منتهي" : p.active ? "مفعّل" : "متوقف"),
      render: (p) => (
        <StatusPill tone={isPromoExhausted(p) ? "orange" : p.active ? "green" : "neutral"}>
          {isPromoExhausted(p) ? "منتهي" : p.active ? "مفعّل" : "متوقف"}
        </StatusPill>
      ),
    },
    { key: "actions", header: "إجراءات", render: (p) => (
      <div className="ui-table__actions">
        <Button variant="ghost" size="sm" onClick={() => openEditPromo(p)}>تعديل</Button>
        <Button variant="ghost" size="sm" onClick={() => togglePromo(p)}>{p.active ? "إيقاف" : "تفعيل"}</Button>
        <Button variant="ghost" size="sm" icon="trash" onClick={() => removePromo(p.id)} />
      </div>
    ) },
  ];

  const campaignColumns = [
    { key: "name", header: "الحملة", value: (c) => c.name, render: (c) => <strong>{c.name}</strong> },
    { key: "description", header: "الوصف", value: (c) => c.description || "—", render: (c) => c.description || "—" },
    { key: "period", header: "الفترة", value: (c) => `${c.start_date ? dateOnly(c.start_date) : "—"} ← ${c.end_date ? dateOnly(c.end_date) : "—"}`, render: (c) => `${c.start_date ? dateOnly(c.start_date) : "—"} ← ${c.end_date ? dateOnly(c.end_date) : "—"}` },
    { key: "promotion_count", header: "العروض" },
    { key: "active", header: "الحالة", value: (c) => (c.active ? "مفعّلة" : "متوقفة"), render: (c) => <StatusPill tone={c.active ? "green" : "neutral"}>{c.active ? "مفعّلة" : "متوقفة"}</StatusPill> },
    { key: "actions", header: "إجراءات", render: (c) => (
      <div className="ui-table__actions">
        <Button variant="ghost" size="sm" onClick={() => toggleCampaign(c)}>{c.active ? "إيقاف" : "تفعيل"}</Button>
        <Button variant="ghost" size="sm" icon="trash" onClick={() => removeCampaign(c.id)} />
      </div>
    ) },
  ];

  const reportConfig = useMemo(() => {
    if (tab === "campaigns") {
      return {
        title: "حملات التسويق",
        columns: pickExportColumns(campaignColumns),
        rows: campaigns,
        filename: "marketing-campaigns",
      };
    }
    return {
      title: "العروض الترويجية",
      columns: pickExportColumns(promoColumns),
      rows: promotions,
      filename: "marketing-promotions",
    };
  }, [tab, campaigns, promotions]);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader icon="marketing" title="التسويق والعروض" subtitle="الحملات والعروض الترويجية المطبّقة في نقطة البيع"
        actions={
          <>
            <ReportToolbar
              title={reportConfig.title}
              columns={reportConfig.columns}
              rows={reportConfig.rows}
              filename={reportConfig.filename}
              disabled={loading}
            />
            {tab === "promotions"
              ? <Button icon="plus" onClick={openNewPromo}>عرض جديد</Button>
              : <Button icon="plus" onClick={() => setShowCampaign(true)}>حملة جديدة</Button>}
          </>
        } />

      <Tabs active={tab} onChange={setTab} tabs={[
        { id: "promotions", label: "العروض", icon: "marketing" },
        { id: "campaigns", label: "الحملات", icon: "vouchers" },
      ]} />

      {tab === "promotions" && (
        <DataTable
          loading={loading}
          columns={promoColumns}
          rows={promotions}
          emptyIcon="marketing"
          empty="لا توجد عروض"
        />
      )}

      {tab === "campaigns" && (
        <DataTable
          loading={loading}
          columns={campaignColumns}
          rows={campaigns}
          emptyIcon="vouchers"
          empty="لا توجد حملات"
        />
      )}

      {/* Campaign modal */}
      <Modal open={showCampaign} title="حملة جديدة" onClose={() => setShowCampaign(false)}
        footer={<><Button onClick={saveCampaign}>حفظ</Button><Button variant="secondary" onClick={() => setShowCampaign(false)}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="اسم الحملة" required className="ui-field--full"><Input value={campaignForm.name} onChange={(e) => setCampaignForm((f) => ({ ...f, name: e.target.value }))} /></FormField>
          <FormField label="من تاريخ"><Input type="date" value={campaignForm.start_date} onChange={(e) => setCampaignForm((f) => ({ ...f, start_date: e.target.value }))} /></FormField>
          <FormField label="إلى تاريخ"><Input type="date" value={campaignForm.end_date} onChange={(e) => setCampaignForm((f) => ({ ...f, end_date: e.target.value }))} /></FormField>
          <FormField label="الوصف" className="ui-field--full"><Textarea value={campaignForm.description} onChange={(e) => setCampaignForm((f) => ({ ...f, description: e.target.value }))} /></FormField>
        </FormGrid>
      </Modal>

      {/* Promotion modal */}
      <Modal open={showPromo} title={editingPromoId ? "تعديل العرض" : "عرض ترويجي جديد"} onClose={() => setShowPromo(false)} size="lg"
        footer={<><Button onClick={savePromo}>حفظ</Button><Button variant="secondary" onClick={() => setShowPromo(false)}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="اسم العرض" required><Input value={promoForm.name} onChange={(e) => setPromoForm((f) => ({ ...f, name: e.target.value }))} /></FormField>
          <FormField label="نوع العرض">
            <Select value={promoForm.offer_type} onChange={(e) => setPromoForm((f) => ({ ...f, offer_type: e.target.value }))}>
              {OFFER_TYPE_ORDER.map((v) => <option key={v} value={v}>{OFFER_LABELS[v]}</option>)}
            </Select>
          </FormField>
          <FormField label="الحملة (اختياري)">
            <Select value={promoForm.campaign_id} onChange={(e) => setPromoForm((f) => ({ ...f, campaign_id: e.target.value }))}>
              <option value="">— بدون —</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </FormField>
        </FormGrid>

        <div className="ui-text-muted ui-mt-sm">النطاق (منتج محدد أو فئة)</div>
        <div className="ui-toolbar--compact">
          <ProductPicker onPick={(p) => setPromoForm((f) => ({
            ...f,
            product_id: p.id,
            product_name: p.name,
            category: "",
            product_unit_id: "",
            stop_when_out_of_stock: false,
          }))} />
          {promoForm.product_name && (
            <p className="ui-field__hint ui-mt-sm">
              المنتج: <strong>{promoForm.product_name}</strong>{" "}
              <Button variant="ghost" size="sm" onClick={() => setPromoForm((f) => ({
                ...f,
                product_id: null,
                product_name: "",
                product_unit_id: "",
                stop_when_out_of_stock: false,
              }))}>إزالة</Button>
            </p>
          )}
          {promoForm.product_id && unitsLoading && (
            <p className="ui-field__hint ui-mt-sm ui-text-muted">جاري تحميل الوحدات...</p>
          )}
          {promoForm.product_id && !unitsLoading && productUnits.length === 0 && (
            <p className="ui-field__hint ui-mt-sm ui-text-muted">لا توجد وحدات لهذا المنتج</p>
          )}
        </div>
        {promoForm.product_id && productUnits.length > 0 && (
          <FormField label="الوحدة" required>
            <Select
              value={promoForm.product_unit_id}
              onChange={(e) => setPromoForm((f) => ({ ...f, product_unit_id: e.target.value }))}
            >
              {productUnits.map((u) => (
                <option key={u.id} value={u.id}>{u.unit_name}</option>
              ))}
            </Select>
          </FormField>
        )}
        <FormField label="أو فئة المنتجات">
          <Input value={promoForm.category} disabled={!!promoForm.product_id} onChange={(e) => setPromoForm((f) => ({ ...f, category: e.target.value }))} />
        </FormField>

        <FormGrid>
          {needsMultiPrice && (
            <p className="ui-field__hint ui-field--full">
              أدخل الكمية وسعر البيع النهائي للعرض (مثال: 2 صناديق بـ ₪15)
            </p>
          )}
          {needsValue && (
            <FormField label={promoForm.offer_type === "percentage" ? "نسبة الخصم %" : "قيمة الخصم (₪)"}>
              <Input type="number" step="0.01" value={promoForm.discount_value} onChange={(e) => setPromoForm((f) => ({ ...f, discount_value: e.target.value }))} />
            </FormField>
          )}
          {needsBxgy && <FormField label="اشترِ (كمية)"><Input type="number" value={promoForm.buy_qty} onChange={(e) => setPromoForm((f) => ({ ...f, buy_qty: e.target.value }))} /></FormField>}
          {needsBxgy && <FormField label="احصل على (مجاناً)"><Input type="number" value={promoForm.get_qty} onChange={(e) => setPromoForm((f) => ({ ...f, get_qty: e.target.value }))} /></FormField>}
          {needsBundleQty && <FormField label="الكمية المطلوبة للحزمة"><Input type="number" value={promoForm.buy_qty} onChange={(e) => setPromoForm((f) => ({ ...f, buy_qty: e.target.value }))} /></FormField>}
          {needsMultiPrice && <FormField label="الكمية"><Input type="number" value={promoForm.buy_qty} onChange={(e) => setPromoForm((f) => ({ ...f, buy_qty: e.target.value }))} /></FormField>}
          {needsMultiPrice && <FormField label="سعر البيع (₪)"><Input type="number" step="1" inputMode="decimal" value={promoForm.discount_value} onChange={(e) => setPromoForm((f) => ({ ...f, discount_value: e.target.value }))} /></FormField>}
          {!needsMultiPrice && (
            <FormField label="حد أدنى للمبلغ (₪)"><Input type="number" step="0.01" value={promoForm.min_amount} onChange={(e) => setPromoForm((f) => ({ ...f, min_amount: e.target.value }))} /></FormField>
          )}
        </FormGrid>

        <div className="ui-text-muted ui-mt-sm">انتهاء العرض</div>
        <FormGrid>
          <FormField label="ينتهي بتاريخ محدد" className="ui-field--full">
            <label className="ui-checkbox-label">
              <input
                type="checkbox"
                checked={promoForm.use_dates}
                onChange={(e) => setPromoForm((f) => ({
                  ...f,
                  use_dates: e.target.checked,
                  start_date: e.target.checked ? f.start_date : "",
                  end_date: e.target.checked ? f.end_date : "",
                }))}
              />
              <span>تفعيل انتهاء العرض بتاريخ</span>
            </label>
          </FormField>
          {promoForm.use_dates && (
            <>
              <FormField label="من تاريخ"><Input type="date" value={promoForm.start_date} onChange={(e) => setPromoForm((f) => ({ ...f, start_date: e.target.value }))} /></FormField>
              <FormField label="إلى تاريخ"><Input type="date" value={promoForm.end_date} onChange={(e) => setPromoForm((f) => ({ ...f, end_date: e.target.value }))} /></FormField>
            </>
          )}
          <FormField label="ينتهي بعد كمية محددة" className="ui-field--full">
            <label className="ui-checkbox-label">
              <input
                type="checkbox"
                checked={promoForm.use_limit_qty}
                onChange={(e) => setPromoForm((f) => ({
                  ...f,
                  use_limit_qty: e.target.checked,
                  limit_qty: e.target.checked ? f.limit_qty : "",
                }))}
              />
              <span>تحديد عدد الوحدات المشمولة بالعرض</span>
            </label>
          </FormField>
          {promoForm.use_limit_qty && (
            <FormField label="عدد الوحدات">
              <Input type="number" step="1" min="1" value={promoForm.limit_qty} onChange={(e) => setPromoForm((f) => ({ ...f, limit_qty: e.target.value }))} />
            </FormField>
          )}
          <FormField label="حتى نفاد المخزون" className="ui-field--full">
            <label className="ui-checkbox-label">
              <input
                type="checkbox"
                checked={promoForm.stop_when_out_of_stock}
                disabled={!promoForm.product_id}
                onChange={(e) => setPromoForm((f) => ({ ...f, stop_when_out_of_stock: e.target.checked }))}
              />
              <span>إيقاف العرض عند نفاد مخزون المنتج</span>
            </label>
          </FormField>
        </FormGrid>
      </Modal>
    </div>
  );
}
