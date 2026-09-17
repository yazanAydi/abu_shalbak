import { apiErrorMessage } from "../../utils/apiError";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api, { createAbortController } from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { dateOnly, qty as fmtQty } from "../../utils/format";
import { printInventoryDocument, printInventoryDocumentHtml } from "../../utils/inventoryDocumentPrint";
import {
  PageHeader,
  Button,
  DataTable,
  FilterBar,
  FormField,
  Input,
  Select,
  StatusPill,
  useToast,
} from "../../components/ui";
import { docConfig, reasonLabel } from "./constants";

export default function InventoryDocumentsList({ docType }) {
  const cfg = docConfig(docType);
  const toast = useToast();
  const navigate = useNavigate();
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [store, setStore] = useState({});
  const loadAbortRef = useRef(null);
  const loadReqRef = useRef(0);
  const [filters, setFilters] = useState({
    search: "",
    from: "",
    to: "",
    reason: "",
    created_by: "",
    status: "",
  });

  useEffect(() => {
    api.get("/api/settings", { headers: getAuthHeaders() }).then(({ data }) => setStore(data || {})).catch(() => {});
    api.get("/api/admin/users", { headers: getAuthHeaders() }).then(({ data }) => {
      const list = Array.isArray(data) ? data : data?.users || data?.items || [];
      setUsers(list);
    }).catch(() => {});
  }, []);

  const load = useCallback(async () => {
    loadAbortRef.current?.abort();
    const ac = createAbortController();
    loadAbortRef.current = ac;
    const reqId = ++loadReqRef.current;
    setLoading(true);
    try {
      const params = {};
      if (filters.search.trim()) params.search = filters.search.trim();
      if (filters.from) params.from = filters.from;
      if (filters.to) params.to = filters.to;
      if (filters.reason) params.reason = filters.reason;
      if (filters.created_by) params.created_by = filters.created_by;
      if (filters.status) params.status = filters.status;
      const { data } = await api.get(cfg.apiBase, {
        params,
        headers: getAuthHeaders(),
        signal: ac.signal,
      });
      if (reqId !== loadReqRef.current) return;
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      if (e.code === "ERR_CANCELED" || e.name === "CanceledError") return;
      if (reqId !== loadReqRef.current) return;
      toast.error(apiErrorMessage(e, "تعذّر تحميل السندات"));
      setRows([]);
    } finally {
      if (reqId === loadReqRef.current) setLoading(false);
    }
  }, [cfg.apiBase, filters.created_by, filters.from, filters.reason, filters.search, filters.status, filters.to]);

  useEffect(() => {
    load();
    return () => loadAbortRef.current?.abort();
  }, [load]);

  const printRow = useCallback(async (id) => {
    try {
      const { data } = await api.get(`${cfg.apiBase}/${id}/print`, {
        headers: getAuthHeaders(),
        responseType: "text",
      });
      if (typeof data === "string" && data.includes("<html")) {
        printInventoryDocumentHtml(data);
        return;
      }
      const detail = await api.get(`${cfg.apiBase}/${id}`, { headers: getAuthHeaders() });
      printInventoryDocument(detail.data, store);
    } catch {
      toast.error("تعذّر التحميل للطباعة");
    }
  }, [cfg.apiBase, store, toast]);

  const columns = useMemo(
    () => [
      { key: "idx", header: "#", render: (_r, i) => i + 1 },
      { key: "document_number", header: "رقم السند" },
      {
        key: "document_date",
        header: "التاريخ",
        render: (r) => dateOnly(r.document_date),
      },
      {
        key: "reason",
        header: "السبب",
        render: (r) => r.reason_label || reasonLabel(docType, r.reason),
      },
      { key: "item_count", header: "عدد الأصناف", className: "num", align: "left" },
      {
        key: "total_base_quantity",
        header: "إجمالي الكمية",
        className: "num",
        align: "left",
        render: (r) => fmtQty(r.total_base_quantity),
      },
      { key: "created_by_name", header: "أنشأه", render: (r) => r.created_by_name || "—" },
      {
        key: "status",
        header: "الحالة",
        render: () => <StatusPill tone="green">مكتمل</StatusPill>,
      },
      {
        key: "actions",
        header: "الإجراءات",
        render: (r) => (
          <div className="ui-table__actions">
            <Button variant="ghost" size="sm" onClick={() => navigate(`${cfg.pathBase}/${r.id}`)}>
              عرض
            </Button>
            <Button variant="ghost" size="sm" icon="print" onClick={() => printRow(r.id)}>
              طباعة
            </Button>
          </div>
        ),
      },
    ],
    [cfg.pathBase, docType, navigate, printRow]
  );

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="inventory"
        title={cfg.listTitle}
        actions={
          <Button onClick={() => navigate(`${cfg.pathBase}/new`)}>سند جديد</Button>
        }
      />
      <FilterBar>
        <FormField label="رقم السند">
          <Input
            value={filters.search}
            onChange={(e) => setFilters((p) => ({ ...p, search: e.target.value }))}
            placeholder="GIN / GOUT"
          />
        </FormField>
        <FormField label="من تاريخ">
          <Input
            type="date"
            value={filters.from}
            onChange={(e) => setFilters((p) => ({ ...p, from: e.target.value }))}
          />
        </FormField>
        <FormField label="إلى تاريخ">
          <Input
            type="date"
            value={filters.to}
            onChange={(e) => setFilters((p) => ({ ...p, to: e.target.value }))}
          />
        </FormField>
        <FormField label="السبب">
          <Select
            value={filters.reason}
            onChange={(e) => setFilters((p) => ({ ...p, reason: e.target.value }))}
          >
            <option value="">كل الأسباب</option>
            {cfg.reasons.map((r) => (
              <option key={r.code} value={r.code}>
                {r.labelAr}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="أنشأه">
          <Select
            value={filters.created_by}
            onChange={(e) => setFilters((p) => ({ ...p, created_by: e.target.value }))}
          >
            <option value="">الكل</option>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.username}
              </option>
            ))}
          </Select>
        </FormField>
        <FormField label="الحالة">
          <Select
            value={filters.status}
            onChange={(e) => setFilters((p) => ({ ...p, status: e.target.value }))}
          >
            <option value="">الكل</option>
            <option value="completed">مكتمل</option>
          </Select>
        </FormField>
      </FilterBar>
      <DataTable
        columns={columns}
        rows={rows}
        loading={loading}
        empty="لا توجد سندات"
        emptyIcon="inventory"
      />
    </div>
  );
}
