import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import useAuthUser from "../hooks/useAuthUser";
import StockCountLineEditor from "../components/inventory/StockCountLineEditor";
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
import { dateTime, dateOnly, dmyToYmd } from "../utils/format";
import { toLatinDigits } from "../utils/forceLatinDigits";
import { UNDATED_BATCH_LABEL } from "../utils/stockBatchLabels";
import { focusInvoiceField } from "../utils/invoiceLineEntry";
import {
  countLinesPayload,
  countScopeParams,
  editorRowFromCountLine,
  firstIncompleteCount,
  groupCountRows,
  removedProductIds,
  validateCountDraft,
} from "../utils/stockCountEntry";

const SESSION_COLUMNS = [
  { key: "id", header: "رقم" },
  {
    key: "status",
    header: "الحالة",
    value: (s) => (s.status === "open" ? "مفتوح" : s.status === "posted" ? "مرحّل" : "ملغي"),
  },
  { key: "created_at", header: "أُنشئ في", value: (s) => dateTime(s.created_at) },
  { key: "created_by_name", header: "بواسطة", value: (s) => s.created_by_name || "—" },
];

const ENTRY_COLUMNS = [
  { key: "name", header: "الصنف", nameColumn: true, wrap: true },
  { key: "counted_qty", header: "الكمية المعدودة", className: "num" },
  {
    key: "expiry_date",
    header: "تاريخ الصلاحية",
    value: (row) => (row.expiry_date ? dateOnly(row.expiry_date) : UNDATED_BATCH_LABEL),
  },
];

export default function InventoryCount({ embedded = false, scope = "retail", membership = null }) {
  const canZeroAllStock = isAdminRole(useAuthUser()?.role);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeSession, setActiveSession] = useState(null);
  const [draftLines, setDraftLines] = useState([]);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState(null);
  const [zeroPasswordSet, setZeroPasswordSet] = useState(false);
  const [zeroModalOpen, setZeroModalOpen] = useState(false);
  const [zeroPassword, setZeroPassword] = useState("");
  const [zeroPasswordError, setZeroPasswordError] = useState(null);
  const loadedIdsRef = useRef(new Set());
  const scopeParams = useMemo(() => countScopeParams(scope, membership), [scope, membership]);
  const department = scopeParams.department;
  const departmentLabel = department === "bakery" ? "المخبز" : "السوبرماركت";

  const loadSessions = useCallback(async () => {
    try {
      const { data } = await api.get("/api/inventory/counts", {
        headers: getAuthHeaders(),
        params: { department },
      });
      const rows = Array.isArray(data) ? data : [];
      setSessions(rows.filter((row) => !row.department || row.department === department));
    } catch {
      setError("تعذّر تحميل جلسات الجرد");
    } finally {
      setLoading(false);
    }
  }, [department]);

  useEffect(() => {
    setActiveSession(null);
    setDraftLines([]);
    loadedIdsRef.current = new Set();
    setError(null);
    setMsg(null);
    setLoading(true);
  }, [department]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  useEffect(() => {
    api
      .get("/api/settings", { headers: getAuthHeaders() })
      .then(({ data }) => {
        setZeroPasswordSet(!!data?.zero_all_stock_password_set);
      })
      .catch(() => {});
  }, []);

  function applySession(data) {
    const rows = (data?.lines || []).map(editorRowFromCountLine);
    setActiveSession(data);
    setDraftLines(rows);
    loadedIdsRef.current = new Set(rows.map((row) => row.product_id).filter(Boolean));
  }

  async function loadSession(id) {
    const { data } = await api.get(`/api/inventory/counts/${id}`, {
      headers: getAuthHeaders(),
      params: scopeParams,
    });
    if (data?.department && data.department !== department) {
      const mismatch = new Error("جلسة الجرد لا تطابق هذا القسم");
      mismatch.response = { data: { error: mismatch.message, code: "COUNT_DEPARTMENT_MISMATCH" } };
      throw mismatch;
    }
    applySession(data);
    return data;
  }

  async function openNew() {
    setError(null);
    setMsg(null);
    try {
      const { data } = await api.post(
        "/api/inventory/counts",
        { department },
        { headers: getAuthHeaders() }
      );
      await loadSessions();
      await loadSession(data.id);
      setMsg("فُتحت جلسة جرد جديدة");
    } catch (e) {
      const existing = e?.response?.data?.session_id;
      if (e?.response?.data?.code === "OPEN_COUNT_EXISTS" && existing) {
        try {
          await loadSession(existing);
          setMsg("فُتحت جلسة الجرد المفتوحة");
          return;
        } catch (loadErr) {
          setError(apiErrorMessage(loadErr, "فشل فتح جلسة"));
          return;
        }
      }
      setError(apiErrorMessage(e, "فشل فتح جلسة"));
    }
  }

  async function loadPictures(rows) {
    const ids = [...groupCountRows(rows).keys()];
    const pictures = {};
    await Promise.all(ids.map(async (id) => {
      const { data } = await api.get("/api/inventory/stock-sources", {
        headers: getAuthHeaders(),
        params: { product_id: id },
      });
      pictures[id] = data;
    }));
    return pictures;
  }

  function showDraftIssue(issue) {
    setError(issue.message);
    if (issue.line_key && issue.field) focusInvoiceField(issue.line_key, issue.field);
  }

  function blockUncommittedExpiry() {
    const editor = document.querySelector("[data-testid='stock-count-editor']");
    if (!editor) return false;
    for (const input of editor.querySelectorAll(".ui-date > input[type='text']")) {
      const text = toLatinDigits(String(input.value || "").trim());
      if (!text || dmyToYmd(text)) continue;
      const lineKey = input.closest("[data-invoice-line]")?.getAttribute("data-invoice-line");
      setDraftLines((prev) => prev.map((row) => (
        String(row.line_key) === String(lineKey) ? { ...row, expiry_invalid: true } : row
      )));
      setError("تاريخ الصلاحية غير صالح");
      if (lineKey) focusInvoiceField(lineKey, "expiry");
      return true;
    }
    return false;
  }

  async function persistDraft(session, rows) {
    if (!session || (session.department && session.department !== department)) {
      setError("جلسة الجرد لا تطابق هذا القسم");
      return null;
    }
    const localIssue = validateCountDraft(rows, null);
    if (localIssue) {
      showDraftIssue(localIssue);
      return null;
    }
    const removed = removedProductIds(loadedIdsRef.current, rows);
    const groups = groupCountRows(rows);
    if (groups.size === 0 && removed.length === 0) {
      setError("أضف صنفاً واحداً على الأقل");
      return null;
    }
    const pictures = await loadPictures(rows);
    const pictureIssue = validateCountDraft(rows, pictures);
    if (pictureIssue) {
      showDraftIssue(pictureIssue);
      return null;
    }

    for (const productId of removed) {
      await api.post(
        `/api/inventory/counts/${session.id}/lines`,
        { product_id: productId, sources: [], department },
        { headers: getAuthHeaders() }
      );
    }
    for (const [productId, list] of groups) {
      await api.post(
        `/api/inventory/counts/${session.id}/lines`,
        {
          product_id: productId,
          department,
          sources: countLinesPayload(list, pictures[productId]),
        },
        { headers: getAuthHeaders() }
      );
    }
    const saved = await loadSession(session.id);
    return { pictures, saved };
  }

  async function saveDraft() {
    if (!activeSession || activeSession.status !== "open" || saving) return false;
    if (blockUncommittedExpiry()) return false;
    setSaving(true);
    setError(null);
    setMsg(null);
    try {
      const result = await persistDraft(activeSession, draftLines);
      if (!result) return false;
      setMsg("تم حفظ الجرد");
      return true;
    } catch (e) {
      setError(apiErrorMessage(e, "فشل الحفظ"));
      try {
        await loadSession(activeSession.id);
      } catch {
        /* keep the rows on screen if reload fails */
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  async function postSession(session) {
    if (!session || saving) return;
    if (session.department && session.department !== department) {
      setError("جلسة الجرد لا تطابق هذا القسم");
      return;
    }
    if (blockUncommittedExpiry()) return;
    setError(null);
    setMsg(null);
    let pictures;
    try {
      const localIssue = validateCountDraft(draftLines, null);
      if (localIssue) {
        showDraftIssue(localIssue);
        return;
      }
      if (groupCountRows(draftLines).size === 0) {
        setError("لا توجد أسطر جرد");
        return;
      }
      pictures = await loadPictures(draftLines);
      const pictureIssue = validateCountDraft(draftLines, pictures);
      if (pictureIssue) {
        showDraftIssue(pictureIssue);
        return;
      }
      const incomplete = firstIncompleteCount(draftLines, pictures);
      if (incomplete) {
        setError(incomplete.message);
        return;
      }
    } catch (e) {
      setError(apiErrorMessage(e, "فشل الترحيل"));
      return;
    }
    if (!window.confirm("هل تريد ترحيل الجرد وتحديث المخزون؟ لا يمكن التراجع عن هذه الخطوة.")) return;
    setSaving(true);
    try {
      const saved = await persistDraft(session, draftLines);
      if (!saved) return;
      const incomplete = firstIncompleteCount(
        (saved.saved?.lines || []).map(editorRowFromCountLine),
        saved.pictures
      );
      if (incomplete) {
        setError(incomplete.message);
        return;
      }
      await api.post(
        `/api/inventory/counts/${session.id}/post`,
        { department },
        { headers: getAuthHeaders() }
      );
      await loadSessions();
      setActiveSession(null);
      setDraftLines([]);
      loadedIdsRef.current = new Set();
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

  const reportRows = useMemo(
    () => draftLines.filter((row) => row.product_id).map((row) => ({
      name: row.name,
      counted_qty: row.counted_qty,
      expiry_date: row.expiry_date,
    })),
    [draftLines]
  );

  const reportConfig = useMemo(() => {
    if (activeSession) {
      return {
        title: `جلسة جرد #${activeSession.id}`,
        columns: ENTRY_COLUMNS,
        rows: reportRows,
        filename: `inventory-count-${activeSession.id}`,
      };
    }
    return {
      title: "جلسات الجرد",
      columns: SESSION_COLUMNS,
      rows: sessions,
      filename: "inventory-count-sessions",
    };
  }, [activeSession, reportRows, sessions]);

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

  function leaveSession() {
    setActiveSession(null);
    setDraftLines([]);
    loadedIdsRef.current = new Set();
  }

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
                  <PrimaryButton type="button" onClick={saveDraft} disabled={saving}>
                    حفظ الجرد
                  </PrimaryButton>
                ) : null}
                {activeSession.status === "open" ? (
                  <DangerButton type="button" onClick={() => postSession(activeSession)} disabled={saving}>
                    ترحيل الجرد
                  </DangerButton>
                ) : null}
                <SecondaryButton type="button" onClick={leaveSession}>
                  رجوع للقائمة
                </SecondaryButton>
              </div>
            }
          >
            <p className="ui-card__title">
              جلسة جرد #{activeSession.id} — {departmentLabel} — {activeSession.status === "open" ? "مفتوحة" : activeSession.status === "posted" ? "مرحّلة" : "ملغاة"}
            </p>
          </FilterBar>

          <h3 className="ui-section">أسطر الجرد ({reportRows.length})</h3>
          <StockCountLineEditor
            items={draftLines}
            setItems={setDraftLines}
            readOnly={activeSession.status !== "open"}
            scope={scope}
            membership={membership}
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
