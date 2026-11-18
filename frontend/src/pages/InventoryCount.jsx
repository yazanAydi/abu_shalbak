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
import { loadCountPictures } from "../utils/stockCountRequests";
import {
  attachCountExpiryPicture,
  countLinesPayload,
  countScopeParams,
  editorRowFromCountLine,
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

const ZERO_OP_KEY = "abu-shalbak-zero-all-operation";

function rememberZeroOperation(id) {
  try {
    if (id) sessionStorage.setItem(ZERO_OP_KEY, id);
    else sessionStorage.removeItem(ZERO_OP_KEY);
  } catch {
    /* private mode */
  }
}

function storedZeroOperation() {
  try {
    return sessionStorage.getItem(ZERO_OP_KEY) || "";
  } catch {
    return "";
  }
}

function ZeroProgress({ op, unavailable }) {
  if (unavailable && (!op || op.status === "running")) {
    return <Notice tone="warn">حالة التصفير غير متاحة مؤقتًا.</Notice>;
  }
  if (!op || !op.stage) return null;
  const pct = op.indeterminate || op.percent == null ? null : op.percent;
  const showCount = op.processed != null && op.total != null && op.stage !== "preparing";
  return (
    <div className="zero-progress">
      <p className="zero-progress__stage">{op.stage_ar}</p>
      <div
        className="zero-progress__track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct == null ? undefined : pct}
      >
        <div
          className={`zero-progress__bar${op.indeterminate ? " is-indeterminate" : ""}`}
          style={op.indeterminate ? undefined : { width: `${pct || 0}%` }}
        />
      </div>
      {showCount ? (
        <p className="zero-progress__count">
          {`تمت معالجة ${op.processed} من ${op.total} صنفًا`}
          {pct != null ? ` — ${pct}%` : ""}
        </p>
      ) : null}
      {op.status === "completed" ? (
        <p className="zero-progress__count">{`تم تغيير ${op.products_changed ?? 0} صنفًا.`}</p>
      ) : null}
    </div>
  );
}

const ENTRY_COLUMNS = [
  { key: "name", header: "الصنف", nameColumn: true, wrap: true },
  { key: "unit", header: "الوحدة" },
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
  const [expiryCycle, setExpiryCycle] = useState(null);
  const [zeroModalOpen, setZeroModalOpen] = useState(false);
  const [zeroPassword, setZeroPassword] = useState("");
  const [zeroPasswordError, setZeroPasswordError] = useState(null);
  const [zeroOp, setZeroOp] = useState(null);
  const [zeroUnavailable, setZeroUnavailable] = useState(false);
  const loadedIdsRef = useRef(new Set());
  const countFlightRef = useRef(false);
  const zeroFlightRef = useRef(false);
  const zeroAttemptKeyRef = useRef("");
  const zeroRunning = zeroOp?.status === "running";
  const scopeParams = useMemo(() => countScopeParams(scope, membership), [scope, membership]);
  const department = scopeParams.department;
  const departmentLabel = department === "bakery" ? "المخبز" : "السوبرماركت";

  useEffect(() => {
    if (!canZeroAllStock) return undefined;
    let stop = false;
    const stored = storedZeroOperation();
    (async () => {
      try {
        const { data } = await api.get("/api/inventory/zero-all-stock/status", {
          headers: getAuthHeaders(),
          params: stored ? { operation_id: stored } : undefined,
        });
        if (stop || !data?.status) return;
        if (data.status === "running") {
          setZeroOp(data);
          setZeroModalOpen(true);
          setSaving(true);
          zeroFlightRef.current = true;
          rememberZeroOperation(data.operation_id);
        } else if (stored && data.status === "completed") {
          rememberZeroOperation("");
          setMsg(`اكتمل التصفير. تم تغيير ${data.products_changed ?? 0} صنفًا.`);
        } else if (stored && (data.status === "interrupted" || data.status === "failed")) {
          rememberZeroOperation("");
          setError(data.stage_ar || "انقطع التصفير قبل اكتماله. لم يُعاد تشغيله.");
        }
      } catch {
        if (!stop && stored) setZeroUnavailable(true);
      }
    })();
    return () => {
      stop = true;
    };
  }, [canZeroAllStock]);

  useEffect(() => {
    if (!zeroRunning || !zeroOp?.operation_id) return undefined;
    let stop = false;
    let timer = 0;
    const tick = async () => {
      try {
        const { data } = await api.get("/api/inventory/zero-all-stock/status", {
          headers: getAuthHeaders(),
          params: { operation_id: zeroOp.operation_id },
        });
        if (stop) return;
        setZeroUnavailable(false);
        setZeroOp(data);
        if (data.status === "completed") {
          rememberZeroOperation("");
          zeroFlightRef.current = false;
          setSaving(false);
          setMsg(`اكتمل التصفير. تم تغيير ${data.products_changed ?? 0} صنفًا.`);
        } else if (data.status === "failed" || data.status === "interrupted") {
          rememberZeroOperation("");
          zeroFlightRef.current = false;
          setSaving(false);
          setError(data.stage_ar || "انقطع التصفير قبل اكتماله. لم يُعاد تشغيله.");
        }
      } catch {
        if (!stop) setZeroUnavailable(true);
      }
      if (!stop && zeroOp?.status === "running") timer = window.setTimeout(tick, 400);
    };
    timer = window.setTimeout(tick, 400);
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
  }, [zeroRunning, zeroOp?.operation_id, zeroOp?.status]);

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

  useEffect(() => {
    let cancelled = false;
    api.get("/api/inventory/expiry-cycle", {
      headers: getAuthHeaders(),
      params: { scope: department },
    }).then(({ data }) => {
      if (!cancelled) setExpiryCycle(data || null);
    }).catch(() => {
      if (!cancelled) setExpiryCycle(null);
    });
    return () => {
      cancelled = true;
    };
  }, [department, activeSession?.status]);

  function applySession(data, pictures = {}) {
    const rows = (data?.lines || []).map((line) => {
      const row = editorRowFromCountLine(line);
      return pictures[row.product_id] ? attachCountExpiryPicture(row, pictures[row.product_id]) : row;
    });
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

  function showDraftIssue(issue) {
    setError(issue.message);
    if (issue.line_key && issue.field) focusInvoiceField(issue.line_key, issue.field);
  }

  function blockPendingPictures() {
    if (!draftLines.some((row) => row.product_id && !row.expiry_picture_loaded && !row.picture_failed)) return false;
    // Product selection may still seed a recorded expiry. Capture the draft only
    // after that read settles; a failed read can recover in the fresh save batch.
    setMsg(null);
    setError("انتظر اكتمال تحميل بيانات الأصناف، ثم اضغط حفظ الجرد أو ترحيل الجرد مرة أخرى.");
    return true;
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
    const pictures = await loadCountPictures([...groups.keys()]);
    const pictureIssue = validateCountDraft(rows, pictures);
    if (pictureIssue) {
      showDraftIssue(pictureIssue);
      return null;
    }

    const products = [
      ...removed.map((productId) => ({ product_id: productId, sources: [] })),
      ...[...groups].map(([productId, list]) => ({
        product_id: productId,
        sources: countLinesPayload(list, pictures[productId]),
      })),
    ];
    const { data: saved } = await api.post(
      `/api/inventory/counts/${session.id}/lines/bulk`,
      { department, products },
      { headers: getAuthHeaders() }
    );
    applySession(saved, pictures);
    return { pictures, saved };
  }

  async function saveDraft() {
    if (!activeSession || activeSession.status !== "open" || saving || countFlightRef.current) return false;
    if (blockPendingPictures()) return false;
    if (blockUncommittedExpiry()) return false;
    countFlightRef.current = true;
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
      return false;
    } finally {
      countFlightRef.current = false;
      setSaving(false);
    }
  }

  async function postSession(session) {
    if (!session || session.status !== "open" || saving || countFlightRef.current) return;
    if (session.department && session.department !== department) {
      setError("جلسة الجرد لا تطابق هذا القسم");
      return;
    }
    if (blockPendingPictures()) return;
    if (blockUncommittedExpiry()) return;
    setError(null);
    setMsg(null);
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

    } catch (e) {
      setError(apiErrorMessage(e, "فشل الترحيل"));
      return;
    }
    if (!window.confirm("هل تريد اعتماد الكميات والتواريخ المدخلة بدلاً من أرصدة الصنف وتواريخه القديمة في المستودع المعدود؟ لا يمكن التراجع عن هذه الخطوة.")) return;
    countFlightRef.current = true;
    setSaving(true);
    try {
      const saved = await persistDraft(session, draftLines);
      if (!saved) return;
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
      countFlightRef.current = false;
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
    if (zeroRunning) {
      setZeroModalOpen(false);
      return;
    }
    setZeroModalOpen(false);
    setZeroPassword("");
    setZeroPasswordError(null);
  }

  function zeroAttemptKey() {
    if (!zeroAttemptKeyRef.current) {
      const cryptoApi = window.crypto;
      zeroAttemptKeyRef.current = cryptoApi && typeof cryptoApi.randomUUID === "function"
        ? cryptoApi.randomUUID()
        : `zero-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    }
    return zeroAttemptKeyRef.current;
  }

  async function confirmZeroAllStock() {
    if (zeroFlightRef.current || zeroRunning) return;
    if (zeroPasswordSet && !zeroPassword.trim()) {
      setZeroPasswordError("أدخل كلمة المرور للمتابعة");
      return;
    }
    zeroFlightRef.current = true;
    setSaving(true);
    setError(null);
    setMsg(null);
    setZeroPasswordError(null);
    setZeroUnavailable(false);
    let keepRunning = false;
    try {
      const headers = { ...getAuthHeaders(), "Idempotency-Key": zeroAttemptKey() };
      if (zeroPasswordSet) {
        headers["X-Confirm-Password"] = zeroPassword;
      }
      const { data } = await api.post("/api/inventory/zero-all-stock", {}, { headers });
      rememberZeroOperation(data?.operation_id);
      setZeroOp(data);
      if (data?.status === "running") {
        keepRunning = true;
        return;
      }
      if (data?.status === "completed") {
        zeroAttemptKeyRef.current = "";
        rememberZeroOperation("");
        setMsg(`اكتمل التصفير. تم تغيير ${data.products_changed ?? 0} صنفًا.`);
        setZeroModalOpen(false);
        setZeroPassword("");
      }
    } catch (e) {
      if (!e?.response) {
        setZeroUnavailable(true);
        try {
          const { data } = await api.get("/api/inventory/zero-all-stock/status", {
            headers: getAuthHeaders(),
            params: zeroAttemptKeyRef.current ? { operation_id: zeroAttemptKeyRef.current } : undefined,
          });
          if (data?.status === "running") {
            keepRunning = true;
            setZeroUnavailable(false);
            setZeroOp(data);
            rememberZeroOperation(data.operation_id);
            return;
          }
          if (data?.status === "interrupted" || data?.status === "failed") {
            setError(data.stage_ar || "انقطع التصفير قبل اكتماله. لم يُعاد تشغيله.");
            return;
          }
        } catch {
          setError("حالة التصفير غير متاحة مؤقتًا.");
          return;
        }
        setError("حالة التصفير غير متاحة مؤقتًا.");
        return;
      }
      const message = apiErrorMessage(e, "فشل تصفير الكميات");
      if (zeroPasswordSet) {
        setZeroPasswordError(message);
      } else {
        setError(message);
        setZeroModalOpen(false);
      }
    } finally {
      if (!keepRunning) {
        zeroFlightRef.current = false;
        setSaving(false);
      }
    }
  }

  const reportRows = useMemo(
    () => draftLines.filter((row) => row.product_id).map((row) => ({
      name: row.name,
      unit: row.count_unit || row.unit || row.stock_picture?.unit || "",
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
    if (saving || countFlightRef.current) return;
    setActiveSession(null);
    setDraftLines([]);
    loadedIdsRef.current = new Set();
  }

  const content = (
    <>
      {error ? <Notice tone="danger">{error}</Notice> : null}
      {msg ? <Notice tone="success">{msg}</Notice> : null}
      {zeroRunning && !zeroModalOpen ? (
        <ZeroProgress op={zeroOp} unavailable={zeroUnavailable} />
      ) : null}

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
                  <DangerButton type="button" onClick={openZeroAllStock} disabled={saving || zeroRunning}>
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
                <SecondaryButton type="button" onClick={leaveSession} disabled={saving}>
                  رجوع للقائمة
                </SecondaryButton>
              </div>
            }
          >
            <p className="ui-card__title">
              جلسة جرد #{activeSession.id} — {departmentLabel} — {activeSession.status === "open" ? "مفتوحة" : activeSession.status === "posted" ? "مرحّلة" : "ملغاة"}
            </p>
          </FilterBar>

          {saving && countFlightRef.current ? (
            <Notice tone="info">جارٍ حفظ الجرد واعتماد البيانات، يرجى الانتظار…</Notice>
          ) : null}

          {expiryCycle?.message ? (
            <Notice tone="warn">
              <div>{expiryCycle.message}</div>
              <div>علّم «تم التحقق من التاريخ» على كل سطر طابقت تاريخه قبل الترحيل. ترحيل الكمية دون هذا التأكيد لا يعيد الصنف إلى تقرير الصلاحية.</div>
            </Notice>
          ) : null}
          <h3 className="ui-section">أسطر الجرد ({reportRows.length})</h3>
          <StockCountLineEditor
            items={draftLines}
            setItems={setDraftLines}
            readOnly={saving || activeSession.status !== "open"}
            scope={scope}
            membership={membership}
          />
        </div>
      ) : (
        <div className="sessions-list">
          {expiryCycle?.message ? (
            <Notice tone="warn">{expiryCycle.message}</Notice>
          ) : null}
          <FilterBar
            actions={
              <div className="ui-btn-group">
                <PrimaryButton type="button" onClick={openNew}>فتح جلسة جرد جديدة</PrimaryButton>
                {canZeroAllStock ? (
                  <DangerButton type="button" onClick={openZeroAllStock} disabled={saving || zeroRunning}>
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
            <DangerButton type="button" onClick={confirmZeroAllStock} disabled={saving || zeroRunning || zeroOp?.status === "completed"}>
              {zeroRunning ? "جاري التصفير…" : "تأكيد التصفير"}
            </DangerButton>
            <SecondaryButton type="button" onClick={closeZeroAllStock} disabled={false}>
              {zeroRunning ? "إخفاء" : "إلغاء"}
            </SecondaryButton>
          </>
        }
      >
        {!zeroOp ? (
          <Notice tone="warn">
            هل تريد تصفير كمية كل المنتجات؟ لا يمكن التراجع عن هذه الخطوة.
          </Notice>
        ) : null}
        {hasOpenSession ? (
          <Notice tone="info" className="ui-mt-md">
            يوجد جلسة جرد مفتوحة. ترحيل تلك الجلسة بعد التصفير قد يغيّر المخزون مرة أخرى.
          </Notice>
        ) : null}
        {zeroOp ? <ZeroProgress op={zeroOp} unavailable={zeroUnavailable} /> : null}
        {zeroPasswordSet && !zeroRunning ? (
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
