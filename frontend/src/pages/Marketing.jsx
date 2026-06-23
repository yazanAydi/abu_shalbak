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
  percentage: "خصم نسبة %", fixed: "خصم مبلغ ثابت", bundle: "حزمة", buy_x_get_y: "اشترِ X واحصل على Y",
};

export default function Marketing() {
  const toast = useToast();
  const [tab, setTab] = useState("promotions");
  const [campaigns, setCampaigns] = useState([]);
  const [promotions, setPromotions] = useState([]);
  const [loading, setLoading] = useState(true);

  const [showCampaign, setShowCampaign] = useState(false);
  const [campaignForm, setCampaignForm] = useState({ name: "", description: "", start_date: "", end_date: "", active: true });

  const [showPromo, setShowPromo] = useState(false);
  const emptyPromo = { campaign_id: "", name: "", offer_type: "percentage", product_id: null, product_name: "", category: "", discount_value: "", buy_qty: "", get_qty: "", min_amount: "", start_date: "", end_date: "", active: true };
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

  async function savePromo() {
    if (!promoForm.name.trim()) { toast.error("اسم العرض مطلوب"); return; }
    if (!promoForm.product_id && !promoForm.category.trim()) { toast.error("حدّد منتجاً أو فئة"); return; }
    try {
      await api.post("/api/marketing/promotions", {
        ...promoForm,
        campaign_id: promoForm.campaign_id || null,
        discount_value: Number(promoForm.discount_value) || 0,
        buy_qty: Number(promoForm.buy_qty) || 0,
        get_qty: Number(promoForm.get_qty) || 0,
        min_amount: Number(promoForm.min_amount) || 0,
      }, { headers: getAuthHeaders() });
      toast.success("تمت إضافة العرض"); setShowPromo(false); setPromoForm(emptyPromo); load();
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

  const promoColumns = [
    { key: "name", header: "العرض", value: (p) => p.name, render: (p) => <strong>{p.name}</strong> },
    { key: "offer_type", header: "النوع", value: (p) => OFFER_LABELS[p.offer_type] || p.offer_type, render: (p) => OFFER_LABELS[p.offer_type] || p.offer_type },
    { key: "target", header: "النطاق", value: (p) => p.product_name || (p.category ? `فئة: ${p.category}` : "—"), render: (p) => p.product_name || (p.category ? `فئة: ${p.category}` : "—") },
    {
      key: "value", header: "القيمة",
      value: (p) => {
        if (p.offer_type === "percentage") return `${p.discount_value}%`;
        if (p.offer_type === "buy_x_get_y") return `${p.buy_qty}+${p.get_qty}`;
        return `₪${Number(p.discount_value).toFixed(2)}`;
      },
      render: (p) => {
        if (p.offer_type === "percentage") return `${p.discount_value}%`;
        if (p.offer_type === "buy_x_get_y") return `${p.buy_qty}+${p.get_qty}`;
        return `₪${Number(p.discount_value).toFixed(2)}`;
      },
    },
    { key: "campaign_name", header: "الحملة", value: (p) => p.campaign_name || "—", render: (p) => p.campaign_name || "—" },
    { key: "active", header: "الحالة", value: (p) => (p.active ? "مفعّل" : "متوقف"), render: (p) => <StatusPill tone={p.active ? "green" : "neutral"}>{p.active ? "مفعّل" : "متوقف"}</StatusPill> },
    { key: "actions", header: "إجراءات", render: (p) => (
      <div className="ui-table__actions">
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
              ? <Button icon="plus" onClick={() => { setPromoForm(emptyPromo); setShowPromo(true); }}>عرض جديد</Button>
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
      <Modal open={showPromo} title="عرض ترويجي جديد" onClose={() => setShowPromo(false)} size="lg"
        footer={<><Button onClick={savePromo}>حفظ</Button><Button variant="secondary" onClick={() => setShowPromo(false)}>إلغاء</Button></>}>
        <FormGrid>
          <FormField label="اسم العرض" required><Input value={promoForm.name} onChange={(e) => setPromoForm((f) => ({ ...f, name: e.target.value }))} /></FormField>
          <FormField label="نوع العرض">
            <Select value={promoForm.offer_type} onChange={(e) => setPromoForm((f) => ({ ...f, offer_type: e.target.value }))}>
              {Object.entries(OFFER_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          </FormField>
          <FormField label="الحملة (اختياري)">
            <Select value={promoForm.campaign_id} onChange={(e) => setPromoForm((f) => ({ ...f, campaign_id: e.target.value }))}>
              <option value="">— بدون —</option>
              {campaigns.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </Select>
          </FormField>
        </FormGrid>

        <div style={{ margin: "1rem 0 0.5rem", fontWeight: 700 }}>النطاق (منتج محدد أو فئة)</div>
        <div style={{ marginBottom: "0.5rem" }}>
          <ProductPicker onPick={(p) => setPromoForm((f) => ({ ...f, product_id: p.id, product_name: p.name, category: "" }))} />
          {promoForm.product_name && <p className="ui-field__hint" style={{ marginTop: 4 }}>المنتج: <strong>{promoForm.product_name}</strong> <Button variant="ghost" size="sm" onClick={() => setPromoForm((f) => ({ ...f, product_id: null, product_name: "" }))}>إزالة</Button></p>}
        </div>
        <FormField label="أو فئة المنتجات"><Input value={promoForm.category} disabled={!!promoForm.product_id} onChange={(e) => setPromoForm((f) => ({ ...f, category: e.target.value }))} /></FormField>

        <FormGrid>
          {needsValue && <FormField label={promoForm.offer_type === "percentage" ? "نسبة الخصم %" : "قيمة الخصم (₪)"}><Input type="number" step="0.01" value={promoForm.discount_value} onChange={(e) => setPromoForm((f) => ({ ...f, discount_value: e.target.value }))} /></FormField>}
          {needsBxgy && <FormField label="اشترِ (كمية)"><Input type="number" value={promoForm.buy_qty} onChange={(e) => setPromoForm((f) => ({ ...f, buy_qty: e.target.value }))} /></FormField>}
          {needsBxgy && <FormField label="احصل على (مجاناً)"><Input type="number" value={promoForm.get_qty} onChange={(e) => setPromoForm((f) => ({ ...f, get_qty: e.target.value }))} /></FormField>}
          {needsBundleQty && <FormField label="الكمية المطلوبة للحزمة"><Input type="number" value={promoForm.buy_qty} onChange={(e) => setPromoForm((f) => ({ ...f, buy_qty: e.target.value }))} /></FormField>}
          <FormField label="حد أدنى للمبلغ (₪)"><Input type="number" step="0.01" value={promoForm.min_amount} onChange={(e) => setPromoForm((f) => ({ ...f, min_amount: e.target.value }))} /></FormField>
          <FormField label="من تاريخ"><Input type="date" value={promoForm.start_date} onChange={(e) => setPromoForm((f) => ({ ...f, start_date: e.target.value }))} /></FormField>
          <FormField label="إلى تاريخ"><Input type="date" value={promoForm.end_date} onChange={(e) => setPromoForm((f) => ({ ...f, end_date: e.target.value }))} /></FormField>
        </FormGrid>
      </Modal>
    </div>
  );
}
