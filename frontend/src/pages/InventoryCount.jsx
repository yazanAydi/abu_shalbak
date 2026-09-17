import { useCallback, useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import useAuthUser from "../hooks/useAuthUser";
import ProductPicker from "../components/ProductPicker";
import QtyStepper from "../components/QtyStepper";
import {
  ReportToolbar,
  Modal,
  FormField,
  Input,
  DangerButton,
  SecondaryButton,
  PrimaryButton,
  FilterBar,
  Notice,
  DataTable,
  StatusPill,
} from "../components/ui";
import { apiErrorMessage } from "../utils/apiError";

const SESSION_COLUMNS = [
  { key: "id", header: "رقم" },
  {
    key: "status",
    header: "الحالة",
    value: (s) => (s.status === "open" ? "مفتوح" : s.status === "posted" ? "مرحّل" : "ملغي"),
  },
  { key: "created_at", header: "أُنشئ في", value: (s) => s.created_at?.slice(0, 16) || "—" },
  { key: "created_by_name", header: "بواسطة", value: (s) => s.created_by_name || "—" },
];

const LINE_COLUMNS = [
  { key: "name", header: "المنتج", nameColumn: true, wrap: true },
  { key: "barcode", header: "الباركود" },
  { key: "system_qty", header: "رصيد النظام", className: "num" },
  { key: "counted_qty", header: "المعدود", className: "num" },
  {
    key: "variance",
    header: "الفرق",
    className: "num",
    value: (L) => `${L.variance > 0 ? "+" : ""}${L.variance}`,
    render: (L) => (
      <span className={L.variance > 0 ? "positive" : L.variance < 0 ? "negative" : ""}>
        {L.variance > 0 ? "+" : ""}{L.variance}
      </span>
    ),
  },
];

export default function InventoryCount({ embedded = false }) {
  const canZeroAllStock = isAdminRole(useAuthUser()?.role);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [countedQty, setCountedQty] = useState("");
  const [selectedProduct, setSelectedProduct] = useState(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [zeroPasswordSet, setZeroPasswordSet] = useState(false);
  const [zeroModalOpen, setZeroModalOpen] = useState(false);
  const [zeroPassword, setZeroPassword] = useState("");
  const [zeroPasswordError, setZeroPasswordError] = useState(null);

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await api.get("/api/inventory/counts", { headers: getAuthHeaders() });
      setSessions(Array.isArray(data) ? data : []);
    } catch {
      setError("تعذّر تحميل جلسات الجرد");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  useEffect(() => {
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => {
        setZeroPasswordSet(!!data?.zero_all_stock_password_set);
      })
      .catch(() => {});
  }, []);

  async function loadSession(id) {
    const { data } = await api.get(`/api/inventory/counts/${id}`, { headers: getAuthHeaders() });
    setActiveSession(data);
  }

  async function openNew() {
    setError(null);
    setMsg(null);
    try {
      await api.post("/api/inventory/counts", {}, { headers: getAuthHeaders() });
      await loadSessions();
      setMsg("فُتحت جلسة جرد جديدة");
    } catch (e) {
      setError(apiErrorMessage(e, "فشل فتح جلسة"));
    }
  }

  async function addCountLine(session, product) {
    if (!countedQty || isNaN(Number(countedQty))) return;
    setSaving(true);
    try {
      await api.post(
        `/api/inventory/counts/${session.id}/lines`,
        { product_id: product.id, counted_qty: Number(countedQty) },
        { headers: getAuthHeaders() }
      );
      await loadSession(session.id);
      setSelectedProduct(null);
      setCountedQty("");
      setMsg("تم حفظ الكمية");
    } catch (e) {
      setError(apiErrorMessage(e, "فشل الحفظ"));
    } finally {
      setSaving(false);
    }
  }

  async function postSession(session) {
    if (!window.confirm("هل تريد ترحيل الجرد وتحديث المخزون؟ لا يمكن التراجع عن هذه الخطوة.")) return;
    setSaving(true);
    try {
      await api.post(`/api/inventory/counts/${session.id}/post`, {}, { headers: getAuthHeaders() });
      await loadSessions();
      setActiveSession(null);
      setMsg("تم ترحيل الجرد وتحديث المخزون");
    } catch (e) {
      setError(apiErrorMessage(e, "فشل الترحيل"));
    } finally {
      setSaving(false);
    }
  }

  const hasOpenSession =
    activeSession?.status === "open" || sessions.some((s) => s.status === "open");

  function openZeroAllStock() {
    setZeroPassword("");
    setZeroPasswordError(null);
    setZeroModalOpen(true);
  }

  function closeZeroAllStock() {
    if (saving) return;
    setZeroModalOpen(false);
    setZeroPassword("");
    setZeroPasswordError(null);
  }

  async function confirmZeroAllStock() {
    if (zeroPasswordSet && !zeroPassword.trim()) {
      setZeroPasswordError("أدخل كلمة المرور للمتابعة");
      return;
    }
    setSaving(true);
    setError(null);
    setMsg(null);
    setZeroPasswordError(null);
    try {
      const headers = { ...getAuthHeaders() };
      if (zeroPasswordSet) {
        headers["X-Confirm-Password"] = zeroPassword;
      }
      const { data } = await api.post("/api/inventory/zero-all-stock", {}, { headers });
      const zeroed = data?.products_zeroed ?? 0;
      setMsg(`تم تصفير كميات ${zeroed} منتج`);
      setZeroModalOpen(false);
      setZeroPassword("");
    } catch (e) {
      const message = apiErrorMessage(e, "فشل تصفير الكميات");
      if (zeroPasswordSet) {
        setZeroPasswordError(message);
      } else {
        setError(message);
        setZeroModalOpen(false);
      }
    } finally {
      setSaving(false);
    }
  }

  const reportConfig = useMemo(() => {
    if (activeSession) {
      return {
        title: `جلسة جرد #${activeSession.id}`,
        columns: LINE_COLUMNS,
        rows: activeSession.lines || [],
        filename: `inventory-count-${activeSession.id}`,
      };
    }
    return {
      title: "جلسات الجرد",
      columns: SESSION_COLUMNS,
      rows: sessions,
      filename: "inventory-count-sessions",
    };
  }, [activeSession, sessions]);

  const sessionListColumns = [
    ...SESSION_COLUMNS.slice(0, 1),
    {
      key: "status",
      header: "الحالة",
      value: (s) => (s.status === "open" ? "مفتوح" : s.status === "posted" ? "مرحّل" : "ملغي"),
      render: (s) => (
        <StatusPill tone={s.status === "open" ? "green" : s.status === "posted" ? "blue" : "neutral"}>
          {s.status === "open" ? "مفتوح" : s.status === "posted" ? "مرحّل" : "ملغي"}
        </StatusPill>
      ),
    },
    SESSION_COLUMNS[2],
    SESSION_COLUMNS[3],
    {
      key: "actions",
      header: "عمليات",
      render: (s) => (
        <SecondaryButton size="sm" type="button" onClick={() => loadSession(s.id)}>
          عرض
        </SecondaryButton>
      ),
    },
  ];

  const content = (
    <>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {msg ? <Notice tone="success">{msg}</Notice> : null}

      {activeSession ? (
        <div className="inventory-session">
          <FilterBar
            actions={
              <div className="ui-btn-group">
                <ReportToolbar
                  title={reportConfig.title}
                  columns={reportConfig.columns}
                  rows={reportConfig.rows}
                  filename={reportConfig.filename}
                />
                {canZeroAllStock ? (
                  <DangerButton type="button" onClick={openZeroAllStock} disabled={saving}>
                    تصفير كل الكميات
                  </DangerButton>
                ) : null}
                {activeSession.status === "open" ? (
                  <DangerButton type="button" onClick={() => postSession(activeSession)} disabled={saving}>
                    ترحيل الجرد
                  </DangerButton>
                ) : null}
                <SecondaryButton type="button" onClick={() => setActiveSession(null)}>
                  رجوع للقائمة
                </SecondaryButton>
              </div>
            }
          >
            <p className="ui-card__title">
              جلسة جرد #{activeSession.id} — {activeSession.status === "open" ? "مفتوحة" : activeSession.status}
            </p>
          </FilterBar>

          {activeSession.status === "open" && (
            <div className="count-input-area">
              <h3 className="ui-section">إضافة صنف</h3>
              <ProductPicker onPick={setSelectedProduct} />
              {selectedProduct && (
                <div className="count-product-row ui-btn-group">
                  <span>{selectedProduct.name}</span>
                  <span>رصيد النظام: {selectedProduct.stock}</span>
                  <QtyStepper
                    min={0}
                    placeholder="الكمية المعدودة"
                    value={countedQty}
                    onChange={(e) => setCountedQty(e.target.value)}
                  />
                  <PrimaryButton type="button" onClick={() => addCountLine(activeSession, selectedProduct)} disabled={saving}>
                    حفظ
                  </PrimaryButton>
                </div>
              )}
            </div>
          )}

          <h3 className="ui-section">أسطر الجرد ({activeSession.lines?.length || 0})</h3>
          <DataTable
            columns={LINE_COLUMNS}
            rows={activeSession.lines || []}
            empty="لا توجد أسطر جرد بعد"
            emptyIcon="inventory"
            rowClassName={(L) => (L.variance !== 0 ? "variance-row" : undefined)}
          />
        </div>
      ) : (
        <div className="sessions-list">
          <FilterBar
            actions={
              <div className="ui-btn-group">
                <PrimaryButton type="button" onClick={openNew}>فتح جلسة جرد جديدة</PrimaryButton>
                {canZeroAllStock ? (
                  <DangerButton type="button" onClick={openZeroAllStock} disabled={saving}>
                    تصفير كل الكميات
                  </DangerButton>
                ) : null}
                <ReportToolbar
                  title={reportConfig.title}
                  columns={reportConfig.columns}
                  rows={reportConfig.rows}
                  filename={reportConfig.filename}
                  disabled={loading}
                />
              </div>
            }
          />
          <DataTable
            loading={loading}
            columns={sessionListColumns}
            rows={sessions}
            empty="لا توجد جلسات جرد"
            emptyIcon="inventory"
          />
        </div>
      )}

      <Modal
        open={zeroModalOpen}
        onClose={closeZeroAllStock}
        title="تصفير كل الكميات"
        footer={
          <>
            <DangerButton type="button" onClick={confirmZeroAllStock} disabled={saving}>
              {saving ? "جاري التصفير…" : "تأكيد التصفير"}
            </DangerButton>
            <SecondaryButton type="button" onClick={closeZeroAllStock} disabled={saving}>
              إلغاء
            </SecondaryButton>
          </>
        }
      >
        <Notice tone="warn">
          هل تريد تصفير كمية كل المنتجات؟ لا يمكن التراجع عن هذه الخطوة.
        </Notice>
        {hasOpenSession ? (
          <Notice tone="info" className="ui-mt-md">
            يوجد جلسة جرد مفتوحة. ترحيل تلك الجلسة بعد التصفير قد يغيّر المخزون مرة أخرى.
          </Notice>
        ) : null}
        {zeroPasswordSet ? (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              confirmZeroAllStock();
            }}
          >
            <FormField label="كلمة مرور التصفير" required error={zeroPasswordError}>
              <Input
                type="password"
                value={zeroPassword}
                autoFocus
                invalid={Boolean(zeroPasswordError)}
                onChange={(e) => {
                  setZeroPassword(e.target.value);
                  if (zeroPasswordError) setZeroPasswordError(null);
                }}
                placeholder="أدخل كلمة المرور للمتابعة"
                autoComplete="current-password"
              />
            </FormField>
          </form>
        ) : null}
      </Modal>
    </>
  );

  if (embedded) return content;
  return (
    <div className="office-page page-container" dir="rtl" lang="ar">
      <div className="page-header">
        <h1>الجرد والمخزون</h1>
      </div>
      {content}
    </div>
  );
}
