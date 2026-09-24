import { apiErrorMessage } from "../utils/apiError";
import { useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { searchProductsApi } from "../utils/productSearch";
import {
  PageHeader,
  Card,
  CardBody,
  PrimaryButton,
  SecondaryButton,
  DangerButton,
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
import useAuthUser from "../hooks/useAuthUser";
import { isAdminRole } from "../utils/roles";
const LABELS = {
  business_day_cutoff_hour: "ساعة بداية يوم العمل (0–23)",
  receipt_show_cashier: "إظهار اسم الكاشير في الإيصال",
  receipt_logo_url: "رابط الشعار",
  store_name_ar: "اسم المتجر",
  store_phone: "الهاتف",
  store_address: "العنوان",
  store_license: "رقم المشتغل المرخص",
  print_show_logo: "إظهار الشعار",
  print_show_name: "إظهار الاسم",
  print_show_phone: "إظهار الهاتف",
  print_show_address: "إظهار العنوان",
  print_show_license: "إظهار المشتغل المرخص",
  default_opening_cash: "النقد الافتتاحي الافتراضي (₪)",
  shift_variance_threshold: "حد الفارق في الوردية (₪)",
  expiry_alert_days: "تنبيه الأصناف الأخرى (أيام)",
  expiry_alert_days_dairy: "تنبيه منتجات الألبان (أيام)",
  pos_shortcut_hold_cart: "اختصار تعليق الفاتورة (مثل F8 أو Ctrl+Shift+L)",
  pos_shortcut_suspended_carts: "اختصار الفواتير المعلقة (مثل F10 أو Ctrl+Shift+U)",
};

const OTHER_CATEGORY = "أخرى";

function normalizeQuickUnitId(value) {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function quickButtonKey(productId, productUnitId) {
  return `${Number(productId)}:${normalizeQuickUnitId(productUnitId) ?? "default"}`;
}

function sameQuickButton(a, productId, productUnitId) {
  return (
    Number(a.product_id) === Number(productId) &&
    normalizeQuickUnitId(a.product_unit_id) === normalizeQuickUnitId(productUnitId)
  );
}

function saleableUnits(units) {
  const list = Array.isArray(units) ? units : [];
  const sale = list.filter((u) => u.sale_enabled !== false);
  return sale.length ? sale : list;
}

function pickDefaultSaleUnitId(units) {
  const pool = saleableUnits(units);
  const def = pool.find((u) => u.is_default) || pool[0];
  return def ? def.id : null;
}

function parseProductUnitsPayload(data) {
  if (Array.isArray(data?.units)) return data.units;
  if (Array.isArray(data)) return data;
  return [];
}

async function fetchProductUnitsList(productId) {
  try {
    const { data } = await api.get(`/api/products/${productId}/units`, {
      headers: getAuthHeaders(),
    });
    return parseProductUnitsPayload(data);
  } catch {
    return [];
  }
}

function usedUnitIdsForProduct(buttons, productId) {
  const used = new Set();
  let hasLegacyDefault = false;
  for (const b of buttons) {
    if (Number(b.product_id) !== Number(productId)) continue;
    const unitId = normalizeQuickUnitId(b.product_unit_id);
    if (unitId == null) hasLegacyDefault = true;
    else used.add(unitId);
  }
  return { used, hasLegacyDefault };
}

export default function StoreSettings() {
  const toast = useToast();
  // The product-delete password is an admin safeguard, so an accountant with
  // the settings page granted must not be able to change it.
  const user = useAuthUser();
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
  const [pendingProduct, setPendingProduct] = useState(null);
  const [pendingCategory, setPendingCategory] = useState("");
  const [pendingUnitId, setPendingUnitId] = useState("");
  const [pendingUnits, setPendingUnits] = useState([]);
  const [pendingUnitsLoading, setPendingUnitsLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sendingExpiryAlert, setSendingExpiryAlert] = useState(false);
  const [msg, setMsg] = useState(null);
  const [error, setError] = useState(null);
  const [deletePasswordSet, setDeletePasswordSet] = useState(false);
  const [deletePassword, setDeletePassword] = useState("");
  const [deletePasswordConfirm, setDeletePasswordConfirm] = useState("");
  const [deletePasswordSaving, setDeletePasswordSaving] = useState(false);
  const [zeroPasswordSet, setZeroPasswordSet] = useState(false);
  const [zeroPassword, setZeroPassword] = useState("");
  const [zeroPasswordConfirm, setZeroPasswordConfirm] = useState("");
  const [zeroPasswordSaving, setZeroPasswordSaving] = useState(false);

  useEffect(() => {
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(async (settingsRes) => {
        const data = settingsRes.data;
        setSettings(data);
        setDeletePasswordSet(!!data.product_delete_password_set);
        setZeroPasswordSet(!!data.zero_all_stock_password_set);
        setForm({
          default_tax_rate: data.default_tax_rate,
          tax_inclusive: data.tax_inclusive,
          business_day_cutoff_hour: data.business_day_cutoff_hour,
          receipt_show_tax: data.receipt_show_tax,
          receipt_show_cashier: data.receipt_show_cashier,
          receipt_logo_url: data.receipt_logo_url || "",
          store_name_ar: data.store_name_ar || "",
          store_phone: data.store_phone || "",
          store_address: data.store_address || "",
          store_license: data.store_license || "",
          print_show_logo: data.print_show_logo !== false,
          print_show_name: data.print_show_name !== false,
          print_show_phone: data.print_show_phone !== false,
          print_show_address: data.print_show_address === true,
          print_show_license: data.print_show_license !== false,
          default_opening_cash: data.default_opening_cash ?? 0,
          shift_variance_threshold: data.shift_variance_threshold ?? 50,
          expiry_alert_days: data.expiry_alert_days ?? 7,
          expiry_alert_days_dairy: data.expiry_alert_days_dairy ?? 3,
          pos_shortcut_hold_cart: data.pos_shortcut_hold_cart ?? "",
          pos_shortcut_suspended_carts: data.pos_shortcut_suspended_carts ?? "",
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
        const ids = buttons.map((b) => b.product_id).filter((id) => Number(id) > 0);
        if (ids.length === 0) {
          setFavoriteLabels({});
          return;
        }
        const uniqueIds = [...new Set(ids.map((id) => Number(id)))];
        const rows = [];
        for (let i = 0; i < uniqueIds.length; i += 100) {
          const chunk = uniqueIds.slice(i, i + 100);
          const { data: products } = await api.get("/api/products", {
            params: { ids: chunk.join(",") },
            headers: getAuthHeaders(),
          });
          const part = Array.isArray(products) ? products : products?.items || [];
          rows.push(...part);
        }
        const namesById = new Map(rows.map((p) => [Number(p.id), p.name]));
        const unitsByProduct = new Map();
        await Promise.all(
          uniqueIds.map(async (id) => {
            unitsByProduct.set(id, await fetchProductUnitsList(id));
          })
        );
        const labels = {};
        for (const b of buttons) {
          const name = namesById.get(Number(b.product_id)) || `#${b.product_id}`;
          const units = unitsByProduct.get(Number(b.product_id)) || [];
          const unitId = normalizeQuickUnitId(b.product_unit_id);
          const unit = unitId ? units.find((u) => Number(u.id) === unitId) : null;
          labels[quickButtonKey(b.product_id, b.product_unit_id)] = unit?.unit_name
            ? `${name} — ${unit.unit_name}`
            : name;
        }
        setFavoriteLabels(labels);
      })
      .catch(() => toast.error("تعذّر تحميل الإعدادات"));
  }, []);

  const pendingLoadRef = useRef(0);

  useEffect(() => {
    const q = productSearch.trim();
    if (!q) {
      setSearchResults([]);
      return undefined;
    }
    const timer = window.setTimeout(async () => {
      try {
        const rows = await searchProductsApi(q, { limit: 12 });
        setSearchResults(rows);
      } catch {
        setSearchResults([]);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [productSearch]);

  function closeAddModal() {
    pendingLoadRef.current += 1;
    setPendingProduct(null);
    setPendingCategory("");
    setPendingUnitId("");
    setPendingUnits([]);
    setPendingUnitsLoading(false);
  }

  function availableUnitsForProduct(productId, units) {
    const saleUnits = saleableUnits(units);
    const { used, hasLegacyDefault } = usedUnitIdsForProduct(quickButtons, productId);
    const defaultId = pickDefaultSaleUnitId(saleUnits);
    return saleUnits.filter((u) => {
      const id = Number(u.id);
      if (used.has(id)) return false;
      if (hasLegacyDefault && defaultId != null && id === Number(defaultId)) return false;
      return true;
    });
  }

  async function openAddModal(product) {
    const loadId = ++pendingLoadRef.current;
    setPendingProduct(product);
    setPendingCategory(quickCategories[0] || OTHER_CATEGORY);
    setPendingUnitId("");
    setPendingUnits([]);
    setPendingUnitsLoading(true);
    setProductSearch("");
    setError(null);

    const units = await fetchProductUnitsList(product.id);
    if (loadId !== pendingLoadRef.current) return;

    if (units.length === 0) {
      const alreadyLegacy = quickButtons.some(
        (b) =>
          Number(b.product_id) === Number(product.id) &&
          normalizeQuickUnitId(b.product_unit_id) == null
      );
      if (alreadyLegacy) {
        closeAddModal();
        setError("تمت إضافة كل وحدات هذا المنتج");
        return;
      }
      setPendingUnits([]);
      setPendingUnitId("");
      setPendingUnitsLoading(false);
      return;
    }

    const available = availableUnitsForProduct(product.id, units);
    if (available.length === 0) {
      closeAddModal();
      setError("تمت إضافة كل وحدات هذا المنتج");
      return;
    }

    setPendingUnits(available);
    const pick = available.find((u) => u.is_default) || available[0];
    setPendingUnitId(pick ? String(pick.id) : "");
    setPendingUnitsLoading(false);
  }

  function confirmAddFavorite() {
    if (!pendingProduct || !pendingCategory) return;
    if (pendingUnitsLoading) return;
    if (pendingUnits.length > 0 && !pendingUnitId) return;
    const unitId = normalizeQuickUnitId(pendingUnitId);
    if (quickButtons.some((b) => sameQuickButton(b, pendingProduct.id, unitId))) return;
    const button = { product_id: pendingProduct.id, category: pendingCategory };
    if (unitId != null) button.product_unit_id = unitId;
    const unitName = pendingUnits.find((u) => Number(u.id) === unitId)?.unit_name;
    setQuickButtons((prev) => [...prev, button]);
    setFavoriteLabels((prev) => ({
      ...prev,
      [quickButtonKey(pendingProduct.id, unitId)]: unitName
        ? `${pendingProduct.name} — ${unitName}`
        : pendingProduct.name,
    }));
    closeAddModal();
  }

  function removeFavorite(productId, productUnitId) {
    setQuickButtons((prev) =>
      prev.filter((b) => !sameQuickButton(b, productId, productUnitId))
    );
  }

  function changeButtonCategory(productId, productUnitId, category) {
    setQuickButtons((prev) =>
      prev.map((b) =>
        sameQuickButton(b, productId, productUnitId) ? { ...b, category } : b
      )
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
        default_opening_cash: Number(form.default_opening_cash),
        shift_variance_threshold: Number(form.shift_variance_threshold),
        expiry_alert_days: Number(form.expiry_alert_days),
        expiry_alert_days_dairy: Number(form.expiry_alert_days_dairy),
        expiry_dairy_categories: dairyCategories,
        pos_quick_categories: quickCategories,
        pos_quick_buttons: quickButtons,
      };
      const { data } = await api.patch("/api/settings", patch, { headers: getAuthHeaders() });
      setSettings(data);
      if (typeof data.product_delete_password_set === "boolean") {
        setDeletePasswordSet(data.product_delete_password_set);
      }
      if (typeof data.zero_all_stock_password_set === "boolean") {
        setZeroPasswordSet(data.zero_all_stock_password_set);
      }
      setQuickCategories(data.pos_quick_categories || quickCategories);
      setDairyCategories(data.expiry_dairy_categories || dairyCategories);
      setQuickButtons(data.pos_quick_buttons || quickButtons);
      setMsg("تم الحفظ بنجاح");
      toast.success("تم الحفظ بنجاح");
    } catch (e) {
      setError(apiErrorMessage(e, "فشل الحفظ"));
      toast.error(apiErrorMessage(e, "فشل الحفظ"));
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
      toast.error(apiErrorMessage(e, "فشل إرسال التنبيه"));
    } finally {
      setSendingExpiryAlert(false);
    }
  }

  async function saveDeletePassword() {
    const password = deletePassword.trim();
    const confirm = deletePasswordConfirm.trim();
    if (password.length < 6) {
      toast.error("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
      return;
    }
    if (password !== confirm) {
      toast.error("كلمتا المرور غير متطابقتين");
      return;
    }
    setDeletePasswordSaving(true);
    try {
      const { data } = await api.put(
        "/api/admin/product-delete-password",
        { password },
        { headers: getAuthHeaders() }
      );
      setDeletePasswordSet(!!data?.product_delete_password_set);
      setDeletePassword("");
      setDeletePasswordConfirm("");
      toast.success(deletePasswordSet ? "تم تغيير كلمة مرور الحذف" : "تم حفظ كلمة مرور الحذف");
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر حفظ كلمة المرور"));
    } finally {
      setDeletePasswordSaving(false);
    }
  }

  async function saveZeroPassword() {
    const password = zeroPassword.trim();
    const confirm = zeroPasswordConfirm.trim();
    if (password.length < 6) {
      toast.error("كلمة المرور يجب أن تكون 6 أحرف على الأقل");
      return;
    }
    if (password !== confirm) {
      toast.error("كلمتا المرور غير متطابقتين");
      return;
    }
    setZeroPasswordSaving(true);
    try {
      const { data } = await api.put(
        "/api/admin/zero-all-stock-password",
        { password },
        { headers: getAuthHeaders() }
      );
      setZeroPasswordSet(!!data?.zero_all_stock_password_set);
      setZeroPassword("");
      setZeroPasswordConfirm("");
      toast.success(zeroPasswordSet ? "تم تغيير كلمة مرور تصفير الكميات" : "تم حفظ كلمة مرور تصفير الكميات");
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر حفظ كلمة المرور"));
    } finally {
      setZeroPasswordSaving(false);
    }
  }

  async function clearZeroPassword() {
    const ok = window.confirm(
      "سيتم حذف كلمة مرور تصفير الكميات، وسيُسمح بعدها بالتصفير بعد التأكيد فقط. متابعة؟"
    );
    if (!ok) return;
    setZeroPasswordSaving(true);
    try {
      await api.delete("/api/admin/zero-all-stock-password", { headers: getAuthHeaders() });
      setZeroPasswordSet(false);
      setZeroPassword("");
      setZeroPasswordConfirm("");
      toast.success("تم حذف كلمة مرور تصفير الكميات");
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر حذف كلمة المرور"));
    } finally {
      setZeroPasswordSaving(false);
    }
  }

  async function clearDeletePassword() {
    const ok = window.confirm(
      "سيتم حذف كلمة مرور الحذف، وسيُطلب بعدها كلمة مرور حساب المسؤول عند حذف منتج. متابعة؟"
    );
    if (!ok) return;
    setDeletePasswordSaving(true);
    try {
      await api.delete("/api/admin/product-delete-password", { headers: getAuthHeaders() });
      setDeletePasswordSet(false);
      setDeletePassword("");
      setDeletePasswordConfirm("");
      toast.success("تم حذف كلمة مرور الحذف");
    } catch (e) {
      toast.error(apiErrorMessage(e, "تعذّر حذف كلمة المرور"));
    } finally {
      setDeletePasswordSaving(false);
    }
  }

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader title="إعدادات المتجر" subtitle="الإيصال، الوردية، وأزرار نقطة البيع السريعة" icon="settings" />

      {!settings ? (
        <div className="ui-page-loading">
          <SkeletonRows rows={8} cols={2} />
        </div>
      ) : (
        <Card>
        <CardBody>
        <form onSubmit={save}>
          <SectionTitle>خيارات الطباعة</SectionTitle>
          <FormGrid>
            <FormField label={LABELS.store_name_ar}>
              <Input
                type="text"
                value={form.store_name_ar || ""}
                onChange={(e) => onChange("store_name_ar", e.target.value)}
              />
            </FormField>
            <FormField label={LABELS.store_phone}>
              <Input
                type="text"
                value={form.store_phone || ""}
                onChange={(e) => onChange("store_phone", e.target.value)}
              />
            </FormField>
            <FormField label={LABELS.store_address} hint="يظهر في المستندات فقط إذا فعّلت إظهار العنوان">
              <Input
                type="text"
                value={form.store_address || ""}
                onChange={(e) => onChange("store_address", e.target.value)}
              />
            </FormField>
            <FormField label={LABELS.store_license}>
              <Input
                type="text"
                value={form.store_license || ""}
                onChange={(e) => onChange("store_license", e.target.value)}
              />
            </FormField>
            <FormField
              label={LABELS.receipt_logo_url}
              hint={`اتركه فارغاً لاستخدام الشعار الافتراضي (${STORE_LOGO_PATH || "/store-logo.png"})`}
            >
              <Input
                type="text"
                value={form.receipt_logo_url || ""}
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
          <div className="settings-check-row">
            <FormField label={LABELS.print_show_logo}>
              <Input
                type="checkbox"
                checked={!!form.print_show_logo}
                onChange={(e) => onChange("print_show_logo", e.target.checked)}
              />
            </FormField>
            <FormField label={LABELS.print_show_name}>
              <Input
                type="checkbox"
                checked={!!form.print_show_name}
                onChange={(e) => onChange("print_show_name", e.target.checked)}
              />
            </FormField>
            <FormField label={LABELS.print_show_phone}>
              <Input
                type="checkbox"
                checked={!!form.print_show_phone}
                onChange={(e) => onChange("print_show_phone", e.target.checked)}
              />
            </FormField>
            <FormField label={LABELS.print_show_address}>
              <Input
                type="checkbox"
                checked={!!form.print_show_address}
                onChange={(e) => onChange("print_show_address", e.target.checked)}
              />
            </FormField>
            <FormField label={LABELS.print_show_license}>
              <Input
                type="checkbox"
                checked={!!form.print_show_license}
                onChange={(e) => onChange("print_show_license", e.target.checked)}
              />
            </FormField>
          </div>

          <SectionTitle>الإيصال والوردية</SectionTitle>
          <div className="settings-check-row">
            <FormField label={LABELS.receipt_show_cashier}>
              <Input
                type="checkbox"
                checked={!!form.receipt_show_cashier}
                onChange={(e) => onChange("receipt_show_cashier", e.target.checked)}
              />
            </FormField>
          </div>

          <SectionTitle>الورديات والكاشير</SectionTitle>
          <FormGrid>
            <FormField
              label={LABELS.business_day_cutoff_hour}
              hint="بتوقيت الخليل: قبل هذه الساعة يُحسب يوم العمل لليوم السابق، وعندها وبعدها لليوم الحالي. يُثبَّت يوم الوردية عند فتحها ولا يتغيّر إذا تغيّر هذا الإعداد. تواريخ الرواتب ودفعات الموردين والمصاريف تبقى كما أُدخلت."
            >
              <Input
                type="number"
                min="0"
                max="23"
                step="1"
                value={form.business_day_cutoff_hour ?? 0}
                onChange={(e) => onChange("business_day_cutoff_hour", e.target.value)}
              />
            </FormField>
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
              {isAdminRole(user?.role) ? (
              <PrimaryButton
                type="button"
                disabled={sendingExpiryAlert}
                onClick={sendExpiryAlertNow}
                className="ui-field__hint"
              >
                {sendingExpiryAlert ? "جاري الإرسال…" : "إرسال تنبيه الصلاحية الآن"}
              </PrimaryButton>
              ) : null}
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

          <SectionTitle>اختصارات نقطة البيع</SectionTitle>
          <p className="settings-favorites-hint">
            لا تستخدم مفاتيح محجوزة للمتصفح مثل F12 أو Ctrl+Shift+I — تفتح أدوات المطوّر أو صفحات المتصفح.
          </p>
          <FormGrid>
            <FormField
              label={LABELS.pos_shortcut_hold_cart}
              hint="مفاتيح آمنة: F8، F10، Ctrl+Shift+L. فارغ يعطّل الاختصار."
            >
              <Input
                type="text"
                value={form.pos_shortcut_hold_cart}
                onChange={(e) => onChange("pos_shortcut_hold_cart", e.target.value)}
                placeholder="اتركه فارغاً لتعطيل الاختصار"
              />
            </FormField>
            <FormField
              label={LABELS.pos_shortcut_suspended_carts}
              hint="مفاتيح آمنة: F8، F10، Ctrl+Shift+U. فارغ يعطّل الاختصار."
            >
              <Input
                type="text"
                value={form.pos_shortcut_suspended_carts}
                onChange={(e) => onChange("pos_shortcut_suspended_carts", e.target.value)}
                placeholder="اتركه فارغاً لتعطيل الاختصار"
              />
            </FormField>
          </FormGrid>
          {error ? <p className="ui-text-danger">{error}</p> : null}

          <SectionTitle>أزرار الكاشير السريعة</SectionTitle>
            <p className="settings-favorites-hint">
              وزّع الأزرار على الأقسام. عند الإضافة يُطلب اختيار القسم والوحدة.
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
                        <span
                          key={quickButtonKey(b.product_id, b.product_unit_id)}
                          className="favorite-chip"
                        >
                          {favoriteLabels[quickButtonKey(b.product_id, b.product_unit_id)] ||
                            `#${b.product_id}`}
                          <Select
                            className="favorite-chip-category"
                            value={b.category}
                            onChange={(e) =>
                              changeButtonCategory(b.product_id, b.product_unit_id, e.target.value)
                            }
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
                            onClick={() => removeFavorite(b.product_id, b.product_unit_id)}
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
                />
                <CameraBarcodeButton
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

      {settings && isAdminRole(user?.role) ? (
        <Card>
          <CardBody>
            <SectionTitle>كلمة مرور حذف المنتجات</SectionTitle>
            <p className="settings-favorites-hint">
              {deletePasswordSet
                ? "كلمة المرور معيّنة. حذف منتج يتطلب هذه الكلمة وليس كلمة مرور حساب المسؤول."
                : "غير معيّنة. حذف منتج يتطلب كلمة مرور حساب المسؤول."}
            </p>
            <FormGrid>
              <FormField label="كلمة المرور الجديدة" required>
                <Input
                  type="password"
                  value={deletePassword}
                  onChange={(e) => setDeletePassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="6 أحرف على الأقل"
                />
              </FormField>
              <FormField label="تأكيد كلمة المرور" required>
                <Input
                  type="password"
                  value={deletePasswordConfirm}
                  onChange={(e) => setDeletePasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  placeholder="أعد إدخال كلمة المرور"
                />
              </FormField>
            </FormGrid>
            <div className="ui-toolbar" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <PrimaryButton
                type="button"
                disabled={deletePasswordSaving}
                onClick={saveDeletePassword}
              >
                {deletePasswordSaving
                  ? "جاري الحفظ…"
                  : deletePasswordSet
                    ? "تغيير"
                    : "حفظ"}
              </PrimaryButton>
              {deletePasswordSet ? (
                <DangerButton
                  type="button"
                  disabled={deletePasswordSaving}
                  onClick={clearDeletePassword}
                >
                  حذف كلمة المرور
                </DangerButton>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      {settings && isAdminRole(user?.role) ? (
        <Card>
          <CardBody>
            <SectionTitle>كلمة مرور تصفير كل الكميات</SectionTitle>
            <p className="settings-favorites-hint">
              {zeroPasswordSet
                ? "كلمة المرور معيّنة. تصفير كل الكميات في الجرد يتطلب هذه الكلمة."
                : "غير معيّنة. تصفير كل الكميات يتطلب التأكيد فقط."}
            </p>
            <FormGrid>
              <FormField label="كلمة المرور الجديدة" required>
                <Input
                  type="password"
                  value={zeroPassword}
                  onChange={(e) => setZeroPassword(e.target.value)}
                  autoComplete="new-password"
                  placeholder="6 أحرف على الأقل"
                />
              </FormField>
              <FormField label="تأكيد كلمة المرور" required>
                <Input
                  type="password"
                  value={zeroPasswordConfirm}
                  onChange={(e) => setZeroPasswordConfirm(e.target.value)}
                  autoComplete="new-password"
                  placeholder="أعد إدخال كلمة المرور"
                />
              </FormField>
            </FormGrid>
            <div className="ui-toolbar" style={{ display: "flex", gap: "0.75rem", flexWrap: "wrap" }}>
              <PrimaryButton
                type="button"
                disabled={zeroPasswordSaving}
                onClick={saveZeroPassword}
              >
                {zeroPasswordSaving
                  ? "جاري الحفظ…"
                  : zeroPasswordSet
                    ? "تغيير"
                    : "حفظ"}
              </PrimaryButton>
              {zeroPasswordSet ? (
                <DangerButton
                  type="button"
                  disabled={zeroPasswordSaving}
                  onClick={clearZeroPassword}
                >
                  حذف كلمة المرور
                </DangerButton>
              ) : null}
            </div>
          </CardBody>
        </Card>
      ) : null}

      <Modal
        open={!!pendingProduct}
        onClose={closeAddModal}
        title="اختر القسم والوحدة"
        footer={
          <>
            <PrimaryButton
              type="button"
              onClick={confirmAddFavorite}
              disabled={pendingUnitsLoading || (pendingUnits.length > 0 && !pendingUnitId)}
            >
              إضافة
            </PrimaryButton>
            <SecondaryButton type="button" onClick={closeAddModal}>
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
            {pendingUnitsLoading ? (
              <p className="ui-field__hint">جاري تحميل الوحدات...</p>
            ) : pendingUnits.length > 0 ? (
              <FormField label="الوحدة" required>
                <Select
                  value={pendingUnitId}
                  onChange={(e) => setPendingUnitId(e.target.value)}
                >
                  {pendingUnits.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.unit_name}
                    </option>
                  ))}
                </Select>
              </FormField>
            ) : (
              <p className="ui-field__hint">سيتم استخدام الوحدة الافتراضية لهذا المنتج.</p>
            )}
          </>
        )}
      </Modal>
    </div>
  );
}
