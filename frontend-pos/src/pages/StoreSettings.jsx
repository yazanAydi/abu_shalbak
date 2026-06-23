import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";

const LABELS = {
  default_tax_rate: "نسبة الضريبة الافتراضية (0–1)",
  tax_inclusive: "السعر شامل الضريبة",
  business_day_cutoff_hour: "ساعة بداية اليوم (0–23)",
  receipt_show_tax: "إظهار الضريبة في الإيصال",
  receipt_show_cashier: "إظهار اسم الكاشير في الإيصال",
  receipt_logo_url: "رابط الشعار في الإيصال",
};

export default function StoreSettings() {
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => {
        setSettings(data);
        setForm({
          default_tax_rate: data.default_tax_rate,
          tax_inclusive: data.tax_inclusive,
          business_day_cutoff_hour: data.business_day_cutoff_hour,
          receipt_show_tax: data.receipt_show_tax,
          receipt_show_cashier: data.receipt_show_cashier,
          receipt_logo_url: data.receipt_logo_url || "",
        });
      })
      .catch(() => setError("تعذّر تحميل الإعدادات"));
  }, []);

  function onChange(key, value) {
    setForm((p) => ({ ...p, [key]: value }));
    setMsg(null);
  }

  async function save(e) {
    e.preventDefault();
    setSaving(true);
    setMsg(null);
    setError(null);
    try {
      const patch = {
        ...form,
        default_tax_rate: Number(form.default_tax_rate),
        business_day_cutoff_hour: Number(form.business_day_cutoff_hour),
      };
      const { data } = await api.patch("/api/settings", patch, { headers: getAuthHeaders() });
      setSettings(data);
      setMsg("تم الحفظ بنجاح");
    } catch (e) {
      setError(e.response?.data?.error || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>إعدادات المتجر</h1>
        <Link to="/checkout" className="nav-pill">← الكاشير</Link>
      </div>

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {!settings ? (
        <p>جاري التحميل…</p>
      ) : (
        <form className="settings-form" onSubmit={save}>
          <div className="settings-grid">
            <div className="settings-row">
              <label>{LABELS.default_tax_rate}</label>
              <input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={form.default_tax_rate}
                onChange={(e) => onChange("default_tax_rate", e.target.value)}
              />
              <small>مثال: 0.16 = 16%</small>
            </div>

            <div className="settings-row">
              <label>{LABELS.tax_inclusive}</label>
              <input
                type="checkbox"
                checked={!!form.tax_inclusive}
                onChange={(e) => onChange("tax_inclusive", e.target.checked)}
              />
              <small>عند التفعيل، سعر الرف يشمل الضريبة (إعداد حسابة الافتراضي)</small>
            </div>

            <div className="settings-row">
              <label>{LABELS.business_day_cutoff_hour}</label>
              <input
                type="number"
                min="0"
                max="23"
                step="1"
                value={form.business_day_cutoff_hour}
                onChange={(e) => onChange("business_day_cutoff_hour", e.target.value)}
              />
              <small>0 = منتصف الليل. اضبط 3 لتقارير المتاجر التي تعمل حتى الفجر</small>
            </div>

            <div className="settings-row">
              <label>{LABELS.receipt_show_tax}</label>
              <input
                type="checkbox"
                checked={!!form.receipt_show_tax}
                onChange={(e) => onChange("receipt_show_tax", e.target.checked)}
              />
            </div>

            <div className="settings-row">
              <label>{LABELS.receipt_show_cashier}</label>
              <input
                type="checkbox"
                checked={!!form.receipt_show_cashier}
                onChange={(e) => onChange("receipt_show_cashier", e.target.checked)}
              />
            </div>

            <div className="settings-row">
              <label>{LABELS.receipt_logo_url}</label>
              <input
                type="text"
                value={form.receipt_logo_url}
                onChange={(e) => onChange("receipt_logo_url", e.target.value)}
                placeholder="https://..."
              />
            </div>
          </div>

          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? "جاري الحفظ…" : "حفظ الإعدادات"}
          </button>
        </form>
      )}
    </div>
  );
}
