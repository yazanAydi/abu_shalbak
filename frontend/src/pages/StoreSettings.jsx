import { useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { searchProductsApi } from "../utils/productSearch";
import {
  PageHeader,
  Card,
  CardBody,
  PrimaryButton,
  SecondaryButton,
  SearchInput,
  Select,
  Modal,
  SectionTitle,
  FormGrid,
  FormField,
  Input,
  SkeletonRows,
  useToast,
} from "../components/ui";
import CameraBarcodeButton from "../components/barcode/CameraBarcodeButton";
import "../components/barcode/barcode-scanner.css";
import { STORE_LOGO_PATH, resolveStoreLogoUrl } from "../utils/storeBranding";
import AccountantPermissionsPanel from "../components/AccountantPermissionsPanel";
import { defaultAccountantPermissions } from "../utils/accountantPermissions";

const LABELS = {
  default_tax_rate: "نسبة الضريبة الافتراضية (0–1)",
  tax_inclusive: "السعر شامل الضريبة",
  business_day_cutoff_hour: "ساعة بداية اليوم (0–23)",
  receipt_show_tax: "إظهار الضريبة في الإيصال",
  receipt_show_cashier: "إظهار اسم الكاشير في الإيصال",
  receipt_logo_url: "رابط الشعار في الإيصال",
  default_opening_cash: "النقد الافتتاحي الافتراضي (₪)",
  shift_variance_threshold: "حد الفارق في الوردية (₪)",
  expiry_alert_days: "تنبيه الأصناف الأخرى (أيام)",
  expiry_alert_days_dairy: "تنبيه منتجات الألبان (أيام)",
  pos_shortcut_hold_cart: "اختصار تعليق الفاتورة (مثل F6 أو Ctrl+H)",
  pos_shortcut_suspended_carts: "اختصار الفواتير المعلقة (مثل F7 أو Ctrl+L)",
};

const OTHER_CATEGORY = "أخرى";
const MAX_QUICK_BUTTONS = 48;

export default function StoreSettings() {
  const toast = useToast();
  const [settings, setSettings] = useState(null);
  const [form, setForm] = useState({});
  const [quickCategories, setQuickCategories] = useState([]);
  const [dairyCategories, setDairyCategories] = useState([]);
  const [newDairyCategoryName, setNewDairyCategoryName] = useState("");
  const [quickButtons, setQuickButtons] = useState([]);
  const [favoriteLabels, setFavoriteLabels] = useState({});
  const [newCategoryName, setNewCategoryName] = useState("");
  const [productSearch, setProductSearch] = useState("");
  const [searchResults, setSearchResults] = useState([]);
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
          expiry_alert_days_dairy: data.expiry_alert_days_dairy ?? 3,
          pos_shortcut_hold_cart: data.pos_shortcut_hold_cart ?? "",
          pos_shortcut_suspended_carts: data.pos_shortcut_suspended_carts ?? "",
          accountant_permissions: data.accountant_permissions ?? defaultAccountantPermissions(),
        });
        const categories = Array.isArray(data.pos_quick_categories)
          ? data.pos_quick_categories
          : [];
        const buttons = Array.isArray(data.pos_quick_buttons) ? data.pos_quick_buttons : [];
        setQuickCategories(categories);
        setDairyCategories(
          Array.isArray(data.expiry_dairy_categories) ? data.expiry_dairy_categories : []
        );
        setQuickButtons(buttons);
        const products = productsRes.data || [];
        setAllProducts(products);
        const labels = {};
        for (const p of products) {
          labels[p.id] = p.name;
        }
        setFavoriteLabels(labels);
      })
      .catch(() => toast.error("تعذّر تحميل الإعدادات"));
  }, []);

  const favoriteIds = useMemo(() => quickButtons.map((b) => b.product_id), [quickButtons]);

  useEffect(() => {
    const q = productSearch.trim();
    if (!q) {
      setSearchResults([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(q, {
          limit: 12,
          excludeIds: favoriteIds,
        });
        setSearchResults(rows);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [productSearch, favoriteIds]);

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

  function deleteDairyCategory(name) {
    setDairyCategories((prev) => prev.filter((c) => c !== name));
    setError(null);
  }

  function addDairyCategory() {
    const name = newDairyCategoryName.trim();
    if (!name) return;
    if (dairyCategories.includes(name)) {
      setError("هذا التصنيف موجود بالفعل");
      return;
    }
    setDairyCategories((prev) => [...prev, name]);
    setNewDairyCategoryName("");
    setError(null);
  }

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
        expiry_alert_days_dairy: Number(form.expiry_alert_days_dairy),
        expiry_dairy_categories: dairyCategories,
        pos_quick_categories: quickCategories,
        pos_quick_buttons: quickButtons,
        accountant_permissions: form.accountant_permissions,
      };
      const { data } = await api.patch("/api/settings", patch, { headers: getAuthHeaders() });
      setSettings(data);
      setQuickCategories(data.pos_quick_categories || quickCategories);
      setDairyCategories(data.expiry_dairy_categories || dairyCategories);
      setQuickButtons(data.pos_quick_buttons || quickButtons);
      setForm((prev) => ({
        ...prev,
        accountant_permissions: data.accountant_permissions ?? prev.accountant_permissions,
      }));
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
        const dairyCount = data.dairy?.count ?? 0;
        const otherCount = data.other?.count ?? data.count ?? 0;
        if (data.dairy && data.other) {
          toast.success(
            `تم إرسال تنبيه الصلاحية (ألبان: ${dairyCount}، أخرى: ${otherCount})`
          );
        } else {
          toast.success(`تم إرسال تنبيه الصلاحية (${data.count} صنف)`);
        }
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

      {!settings ? (
        <div className="ui-page-loading">
          <SkeletonRows rows={8} cols={2} />
        </div>
      ) : (
        <Card>
        <CardBody>
        <form onSubmit={save}>
          <SectionTitle>الضريبة والإيصال</SectionTitle>
          <FormGrid>
            <FormField label={LABELS.default_tax_rate} hint="مثال: 0.16 = 16%">
              <Input
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={form.default_tax_rate}
                onChange={(e) => onChange("default_tax_rate", e.target.value)}
              />
            </FormField>
            <FormField label={LABELS.tax_inclusive} hint="عند التفعيل، سعر الرف يشمل الضريبة">
              <Input
                type="checkbox"
                checked={!!form.tax_inclusive}
                onChange={(e) => onChange("tax_inclusive", e.target.checked)}
              />
            </FormField>
            <FormField
              label={LABELS.business_day_cutoff_hour}
              hint="0 = منتصف الليل. اضبط 3 لتقارير المتاجر التي تعمل حتى الفجر"
            >
              <Input
                type="number"
                min="0"
                max="23"
                step="1"
                value={form.business_day_cutoff_hour}
                onChange={(e) => onChange("business_day_cutoff_hour", e.target.value)}
              />
            </FormField>
            <FormField label={LABELS.receipt_show_tax}>
              <Input
                type="checkbox"
                checked={!!form.receipt_show_tax}
                onChange={(e) => onChange("receipt_show_tax", e.target.checked)}
              />
            </FormField>
            <FormField label={LABELS.receipt_show_cashier}>
              <Input
                type="checkbox"
                checked={!!form.receipt_show_cashier}
                onChange={(e) => onChange("receipt_show_cashier", e.target.checked)}
              />
            </FormField>
            <FormField
              label={LABELS.receipt_logo_url}
              hint={`اتركه فارغاً لاستخدام الشعار الافتراضي (${STORE_LOGO_PATH || "/store-logo.png"})`}
            >
              <Input
                type="text"
                value={form.receipt_logo_url}
                onChange={(e) => onChange("receipt_logo_url", e.target.value)}
                placeholder="اتركه فارغاً للشعار الافتراضي"
              />
              <img
                src={resolveStoreLogoUrl(form.receipt_logo_url)}
                alt=""
                style={{
                  display: "block",
                  marginTop: "0.5rem",
                  maxWidth: "140px",
                  maxHeight: "90px",
                  objectFit: "contain",
                }}
              />
            </FormField>
          </FormGrid>

          <SectionTitle>الورديات والكاشير</SectionTitle>
          <FormGrid>
            <FormField label={LABELS.default_opening_cash} hint="يُستخدم تلقائياً عند بدء وردية الكاشير">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.default_opening_cash}
                onChange={(e) => onChange("default_opening_cash", e.target.value)}
              />
            </FormField>
            <FormField
              label={LABELS.shift_variance_threshold}
              hint="إذا تجاوز الفارق هذا الحد عند عد النقد، تُطلب موافقة المدير"
            >
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.shift_variance_threshold}
                onChange={(e) => onChange("shift_variance_threshold", e.target.value)}
              />
            </FormField>
            <FormField
              label={LABELS.expiry_alert_days_dairy}
              hint="تنبيه منفصل عبر تيليجرام لمنتجات الألبان التي تنتهي خلال هذه المدة"
            >
              <Input
                type="number"
                min="1"
                max="365"
                step="1"
                value={form.expiry_alert_days_dairy}
                onChange={(e) => onChange("expiry_alert_days_dairy", e.target.value)}
              />
            </FormField>
            <FormField
              label={LABELS.expiry_alert_days}
              hint="تنبيه منفصل للأصناف غير المصنّفة كألبان"
            >
              <Input
                type="number"
                min="1"
                max="365"
                step="1"
                value={form.expiry_alert_days}
                onChange={(e) => onChange("expiry_alert_days", e.target.value)}
              />
              <PrimaryButton
                type="button"
                disabled={sendingExpiryAlert}
                onClick={sendExpiryAlertNow}
                className="ui-field__hint"
              >
                {sendingExpiryAlert ? "جاري الإرسال…" : "إرسال تنبيه الصلاحية الآن"}
              </PrimaryButton>
            </FormField>
          </FormGrid>

          <SectionTitle>تصنيفات الألبان للتنبيه</SectionTitle>
          <p className="settings-favorites-hint">
            الأصناف التي يطابق تصنيفها (category) أحد الأسماء أدناه تُرسل في تنبيه الألبان.
            اترك القائمة فارغة لإرسال تنبيه واحد لجميع الأصناف.
          </p>
          <div className="quick-category-list">
            {dairyCategories.map((cat) => (
              <div key={cat} className="quick-category-row">
                <span className="quick-category-name">{cat}</span>
                <button
                  type="button"
                  className="quick-category-delete"
                  onClick={() => deleteDairyCategory(cat)}
                >
                  حذف
                </button>
              </div>
            ))}
          </div>
          <div className="quick-category-add">
            <Input
              type="text"
              value={newDairyCategoryName}
              onChange={(e) => setNewDairyCategoryName(e.target.value)}
              placeholder="مثال: ألبان"
            />
            <SecondaryButton type="button" onClick={addDairyCategory}>
              إضافة تصنيف
            </SecondaryButton>
          </div>

          <SectionTitle>أقسام الأزرار السريعة</SectionTitle>
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
              <Input
                type="text"
                value={newCategoryName}
                onChange={(e) => setNewCategoryName(e.target.value)}
                placeholder="اسم قسم جديد…"
                data-enter-nav-skip=""
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

          <SectionTitle>صلاحيات المحاسب</SectionTitle>
          <p className="settings-favorites-hint">
            اختر الصفحات والميزات التي يمكن لجميع حسابات المحاسب الوصول إليها في لوحة الإدارة.
          </p>
          <AccountantPermissionsPanel
            value={form.accountant_permissions}
            onChange={(accountant_permissions) =>
              setForm((prev) => ({ ...prev, accountant_permissions }))
            }
          />

          <SectionTitle>اختصارات نقطة البيع</SectionTitle>
          <FormGrid>
            <FormField label={LABELS.pos_shortcut_hold_cart}>
              <Input
                type="text"
                value={form.pos_shortcut_hold_cart}
                onChange={(e) => onChange("pos_shortcut_hold_cart", e.target.value)}
                placeholder="اتركه فارغاً لتعطيل الاختصار"
              />
            </FormField>
            <FormField label={LABELS.pos_shortcut_suspended_carts}>
              <Input
                type="text"
                value={form.pos_shortcut_suspended_carts}
                onChange={(e) => onChange("pos_shortcut_suspended_carts", e.target.value)}
                placeholder="اتركه فارغاً لتعطيل الاختصار"
              />
            </FormField>
          </FormGrid>

          <SectionTitle>أزرار الكاشير السريعة</SectionTitle>
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
                          <Select
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
                          </Select>
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

          <PrimaryButton type="submit" disabled={saving} className="ui-toolbar">
            {saving ? "جاري الحفظ…" : "حفظ الإعدادات"}
          </PrimaryButton>
        </form>
        </CardBody>
        </Card>
      )}

      <Modal
        open={!!pendingProduct}
        onClose={() => setPendingProduct(null)}
        title="اختر القسم"
        footer={
          <>
            <PrimaryButton type="button" onClick={confirmAddFavorite}>
              إضافة
            </PrimaryButton>
            <SecondaryButton type="button" onClick={() => setPendingProduct(null)}>
              إلغاء
            </SecondaryButton>
          </>
        }
      >
        {pendingProduct && (
          <>
            <p className="quick-add-product-name">{pendingProduct.name}</p>
            <FormField label="القسم">
              <Select value={pendingCategory} onChange={(e) => setPendingCategory(e.target.value)}>
                {quickCategories.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            </FormField>
          </>
        )}
      </Modal>
    </div>
  );
}
