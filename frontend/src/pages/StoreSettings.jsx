import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import {
  PageHeader,
  Card,
  CardBody,
  PrimaryButton,
  SearchInput,
  useToast,
} from "../components/ui";
import CameraBarcodeButton from "../components/barcode/CameraBarcodeButton";
import "../components/barcode/barcode-scanner.css";

const LABELS = {
  default_tax_rate: "نسبة الضريبة الافتراضية (0–1)",
  tax_inclusive: "السعر شامل الضريبة",
  business_day_cutoff_hour: "ساعة بداية اليوم (0–23)",
  receipt_show_tax: "إظهار الضريبة في الإيصال",
  receipt_show_cashier: "إظهار اسم الكاشير في الإيصال",
  receipt_logo_url: "رابط الشعار في الإيصال",
  default_opening_cash: "النقد الافتتاحي الافتراضي (₪)",
  shift_variance_threshold: "حد الفارق في الوردية (₪)",
  expiry_alert_days: "تنبيه الصلاحية عبر تيليجرام (أيام)",
};

const OTHER_CATEGORY = "أخرى";
const MAX_QUICK_BUTTONS = 48;

export default function StoreSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [quickCategories, setQuickCategories] = useState([]);
  const [quickButtons, setQuickButtons] = useState([]);
  const [favoriteLabels, setFavoriteLabels] = useState({});
  const [newCategoryName, setNewCategoryName] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [allProducts, setAllProducts] = useState([]);
  const [pendingProduct, setPendingProduct] = useState(null);
  const [pendingCategory, setPendingCategory] = useState("");
  const [saving, setSaving] = useState(false);
  const [sendingExpiryAlert, setSendingExpiryAlert] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([
      api.get("/api/settings", { headers: getAuthHeaders() }),
      api.get("/api/products", { headers: getAuthHeaders() }),
    ])
      .then(([settingsRes, productsRes]) => {
        const data = settingsRes.data;
        setSettings(data);
        setForm({
          default_tax_rate: data.default_tax_rate,
          tax_inclusive: data.tax_inclusive,
          business_day_cutoff_hour: data.business_day_cutoff_hour,
          receipt_show_tax: data.receipt_show_tax,
          receipt_show_cashier: data.receipt_show_cashier,
          receipt_logo_url: data.receipt_logo_url || "",
          default_opening_cash: data.default_opening_cash ?? 0,
          shift_variance_threshold: data.shift_variance_threshold ?? 50,
          expiry_alert_days: data.expiry_alert_days ?? 7,
        });
        const categories = Array.isArray(data.pos_quick_categories)
          ? data.pos_quick_categories
          : [];
        const buttons = Array.isArray(data.pos_quick_buttons) ? data.pos_quick_buttons : [];
        setQuickCategories(categories);
        setQuickButtons(buttons);
        const products = productsRes.data || [];
        setAllProducts(products);
        const labels = {};
        for (const p of products) {
          labels[p.id] = p.name;
        }
        setFavoriteLabels(labels);
      })
      .catch(() => setError("تعذّر تحميل الإعدادات"));
  }, []);

  const favoriteIds = quickButtons.map((b) => b.product_id);

  function openAddModal(product) {
    if (quickButtons.length >= MAX_QUICK_BUTTONS) {
      setError(`الحد الأقصى ${MAX_QUICK_BUTTONS} منتجاً`);
      return;
    }
    if (favoriteIds.includes(product.id)) return;
    setPendingProduct(product);
    setPendingCategory(quickCategories[0] || OTHER_CATEGORY);
    setProductSearch("");
    setError(null);
  }

  function confirmAddFavorite() {
    if (!pendingProduct || !pendingCategory) return;
    setQuickButtons((prev) => [
      ...prev,
      { product_id: pendingProduct.id, category: pendingCategory },
    ]);
    setFavoriteLabels((prev) => ({ ...prev, [pendingProduct.id]: pendingProduct.name }));
    setPendingProduct(null);
    setPendingCategory("");
  }

  function removeFavorite(id) {
    setQuickButtons((prev) => prev.filter((b) => b.product_id !== id));
  }

  function changeButtonCategory(productId, category) {
    setQuickButtons((prev) =>
      prev.map((b) => (b.product_id === productId ? { ...b, category } : b))
    );
  }

  function addCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    if (quickCategories.includes(name)) {
      setError("هذا القسم موجود مسبقاً");
      return;
    }
    setQuickCategories((prev) => [...prev, name]);
    setNewCategoryName("");
    setError(null);
  }

  function deleteCategory(name) {
    if (name === OTHER_CATEGORY) return;
    const ok = window.confirm(
      `سيتم حذف قسم "${name}" ونقل أزراره إلى "${OTHER_CATEGORY}". متابعة؟`
    );
    if (!ok) return;
    setQuickCategories((prev) => prev.filter((c) => c !== name));
    setQuickButtons((prev) =>
      prev.map((b) => (b.category === name ? { ...b, category: OTHER_CATEGORY } : b))
    );
    setError(null);
  }

  const searchResults = productSearch.trim()
    ? allProducts
        .filter(
          (p) =>
            !favoriteIds.includes(p.id) &&
            (p.name.includes(productSearch) ||
              (p.barcode && String(p.barcode).includes(productSearch)))
        )
        .slice(0, 12)
    : [];

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
        default_opening_cash: Number(form.default_opening_cash),
        shift_variance_threshold: Number(form.shift_variance_threshold),
        expiry_alert_days: Number(form.expiry_alert_days),
        pos_quick_categories: quickCategories,
        pos_quick_buttons: quickButtons,
      };
      const { data } = await api.patch("/api/settings", patch, { headers: getAuthHeaders() });
      setSettings(data);
      setQuickCategories(data.pos_quick_categories || quickCategories);
      setQuickButtons(data.pos_quick_buttons || quickButtons);
      setMsg("تم الحفظ بنجاح");
      toast.success("تم الحفظ بنجاح");
    } catch (e) {
      setError(e.response?.data?.error || "فشل الحفظ");
      toast.error(e.response?.data?.error || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function sendExpiryAlertNow() {
    setSendingExpiryAlert(true);
    setError(null);
    try {
      const { data } = await api.post("/api/telegram/send-expiry-alert", null, {
        headers: getAuthHeaders(),
      });
      if (data.sent) {
        toast.success(`تم إرسال تنبيه الصلاحية (${data.count} صنف)`);
      } else if (data.reason === "no_items") {
        toast.success("لا توجد أصناف قريبة من انتهاء الصلاحية");
      } else if (data.reason === "telegram_not_configured") {
        toast.error("أضف TELEGRAM_EXPIRY_BOT_TOKEN و TELEGRAM_EXPIRY_CHAT_ID في .env");
      } else {
        toast.error("تعذّر إرسال التنبيه");
      }
    } catch (e) {
      toast.error(e.response?.data?.error || "فشل إرسال التنبيه");
    } finally {
      setSendingExpiryAlert(false);
    }
  }

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader title="إعدادات المتجر" subtitle="الضريبة، الإيصال، وأزرار نقطة البيع السريعة" icon="settings" />

      {error && <div className="error-banner">{error}</div>}
      {msg && <div className="success-banner">{msg}</div>}

      {!settings ? (
        <p>جاري التحميل…</p>
      ) : (
        <Card>
        <CardBody>
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

          <section className="settings-favorites">
            <h2>الورديات والكاشير</h2>
            <div className="settings-grid">
              <div className="settings-row">
                <label>{LABELS.default_opening_cash}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.default_opening_cash}
                  onChange={(e) => onChange("default_opening_cash", e.target.value)}
                />
                <small>يُستخدم تلقائياً عند بدء وردية الكاشير</small>
              </div>
              <div className="settings-row">
                <label>{LABELS.shift_variance_threshold}</label>
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={form.shift_variance_threshold}
                  onChange={(e) => onChange("shift_variance_threshold", e.target.value)}
                />
                <small>إذا تجاوز الفارق هذا الحد عند عد النقد، تُطلب موافقة المدير</small>
              </div>
              <div className="settings-row">
                <label>{LABELS.expiry_alert_days}</label>
                <input
                  type="number"
                  min="1"
                  max="365"
                  step="1"
                  value={form.expiry_alert_days}
                  onChange={(e) => onChange("expiry_alert_days", e.target.value)}
                />
                <small>
                  يُرسل ملخص يومي عبر تيليجرام للأصناف والدفعات التي تنتهي خلال هذه المدة
                </small>
                <PrimaryButton
                  type="button"
                  disabled={sendingExpiryAlert}
                  onClick={sendExpiryAlertNow}
                  style={{ marginTop: "0.5rem" }}
                >
                  {sendingExpiryAlert ? "جاري الإرسال…" : "إرسال تنبيه الصلاحية الآن"}
                </PrimaryButton>
              </div>
            </div>
          </section>

          <section className="settings-favorites">
            <h2>أقسام الأزرار السريعة</h2>
            <p className="settings-favorites-hint">
              تظهر كشريط تنقل في نقطة البيع (معجنات / بيتزا / أخرى). لا يمكن حذف قسم «أخرى».
            </p>
            <div className="quick-category-list">
              {quickCategories.map((cat) => (
                <div key={cat} className="quick-category-row">
                  <span className="quick-category-name">{cat}</span>
                  {cat !== OTHER_CATEGORY && (
                    <button
                      type="button"
                      className="quick-category-delete"
                      onClick={() => deleteCategory(cat)}
                    >
                      حذف
                    </button>
                  )}
                </div>
              ))}
            </div>
            <div className="quick-category-add">
              <input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="اسم قسم جديد…"
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCategory();
                  }
                }}
              />
              <PrimaryButton type="button" onClick={addCategory}>
                إضافة قسم
              </PrimaryButton>
            </div>
          </section>

          <section className="settings-favorites">
            <h2>أزرار الكاشير السريعة</h2>
            <p className="settings-favorites-hint">
              اختر حتى {MAX_QUICK_BUTTONS} منتجاً موزّعة على الأقسام. عند الإضافة يُطلب اختيار القسم.
            </p>
            {quickCategories.map((cat) => {
              const catButtons = quickButtons.filter((b) => b.category === cat);
              return (
                <div key={cat} className="quick-buttons-group">
                  <h3 className="quick-buttons-group-title">{cat}</h3>
                  <div className="favorites-chips">
                    {catButtons.length === 0 ? (
                      <span className="favorites-empty">لا توجد أزرار في هذا القسم</span>
                    ) : (
                      catButtons.map((b) => (
                        <span key={b.product_id} className="favorite-chip">
                          {favoriteLabels[b.product_id] || `#${b.product_id}`}
                          <select
                            className="favorite-chip-category"
                            value={b.category}
                            onChange={(e) => changeButtonCategory(b.product_id, e.target.value)}
                            aria-label="تغيير القسم"
                          >
                            {quickCategories.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            className="favorite-chip-remove"
                            onClick={() => removeFavorite(b.product_id)}
                            aria-label="إزالة"
                          >
                            ×
                          </button>
                        </span>
                      ))
                    )}
                  </div>
                </div>
              );
            })}
            <div className="favorites-search">
              <div className="barcode-input-row">
                <SearchInput
                  placeholder="ابحث بالاسم أو الباركود لإضافة منتج…"
                  value={productSearch}
                  onChange={(e) => setProductSearch(e.target.value)}
                  disabled={quickButtons.length >= MAX_QUICK_BUTTONS}
                />
                <CameraBarcodeButton
                  disabled={quickButtons.length >= MAX_QUICK_BUTTONS}
                  onScan={(code) => setProductSearch(code)}
                />
              </div>
              {searchResults.length > 0 && (
                <ul className="favorites-search-results">
                  {searchResults.map((p) => (
                    <li key={p.id}>
                      <button type="button" onClick={() => openAddModal(p)}>
                        {p.name} — {p.barcode}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>

          <PrimaryButton type="submit" disabled={saving}>
            {saving ? "جاري الحفظ…" : "حفظ الإعدادات"}
          </PrimaryButton>
        </form>
        </CardBody>
        </Card>
      )}

      {pendingProduct && (
        <div className="quick-add-modal-backdrop" onClick={() => setPendingProduct(null)}>
          <div
            className="quick-add-modal"
            role="dialog"
            aria-labelledby="quick-add-title"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 id="quick-add-title">اختر القسم</h3>
            <p className="quick-add-product-name">{pendingProduct.name}</p>
            <label className="quick-add-label">
              القسم
              <select
                value={pendingCategory}
                onChange={(e) => setPendingCategory(e.target.value)}
              >
                {quickCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </label>
            <div className="quick-add-actions">
              <PrimaryButton type="button" onClick={confirmAddFavorite}>
                إضافة
              </PrimaryButton>
              <button type="button" className="btn-secondary" onClick={() => setPendingProduct(null)}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
