import { useMemo, useState } from "react";
import { todayISO } from "../utils/format";
import api from "../apiClient";
import PartyPicker from "../components/PartyPicker";
import AccountStatementView from "../components/AccountStatementView";
import {
  printAccountStatement,
  downloadAccountStatementExcel,
} from "../utils/accountStatementPrint";
import { exportToCsv } from "../utils/reportExport";
import { getDisplayRows } from "../components/AccountStatementView";
import {
  PageHeader,
  Card,
  CardBody,
  Button,
  SecondaryButton,
  FormField,
  FormGrid,
  Input,
  Select,
  useToast,
} from "../components/ui";

function currentYearRange() {
  const y = new Date().getFullYear();
  return { from: `${y}-01-01`, to: todayISO() };
}

export default function AccountStatement() {
  const toast = useToast();
  const defaults = useMemo(() => currentYearRange(), []);
  const [partyType, setPartyType] = useState("supplier");
  const [party, setParty] = useState(null);
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [loading, setLoading] = useState(false);
  const [report, setReport] = useState(null);
  const [page, setPage] = useState(1);
  const pageSize = 100;

  async function loadReport(nextPage = 1) {
    if (!party?.id) {
      toast.error("اختر مورداً أو عميلاً");
      return;
    }
    if (from && to && from > to) {
      toast.error("تاريخ البداية يجب أن يكون قبل النهاية");
      return;
    }
    setLoading(true);
    try {
      const qs = new URLSearchParams({
        partyType,
        partyId: String(party.id),
        page: String(nextPage),
        pageSize: String(pageSize),
      });
      if (from) qs.set("from", from);
      if (to) qs.set("to", to);
      const { data } = await api.get(`/api/reports/account-statement?${qs}`);
      setReport(data);
      setPage(nextPage);
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "تعذّر تحميل كشف الحساب");
      setReport(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadFullForExport() {
    const qs = new URLSearchParams({
      partyType,
      partyId: String(party.id),
      export: "1",
    });
    if (from) qs.set("from", from);
    if (to) qs.set("to", to);
    const { data } = await api.get(`/api/reports/account-statement?${qs}`);
    return data;
  }

  async function handlePrint() {
    if (!party?.id) return;
    try {
      const full = await loadFullForExport();
      printAccountStatement(full, partyType);
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر الطباعة");
    }
  }

  async function handlePdf() {
    await handlePrint();
  }

  async function handleExcel() {
    if (!party?.id) return;
    try {
      await downloadAccountStatementExcel(api, { partyType, partyId: party.id, from, to });
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر تصدير Excel");
    }
  }

  async function handleCsv() {
    if (!party?.id) return;
    try {
      const full = await loadFullForExport();
      const rows = getDisplayRows(full);
      exportToCsv(`kashf-${partyType}-${party.id}`, [
        { key: "line_no", header: "الرقم" },
        { key: "description", header: "البيان" },
        { key: "date", header: "التاريخ" },
        { key: "debit", header: "مدين" },
        { key: "credit", header: "دائن" },
        { key: "balance_formatted", header: "الرصيد" },
        { key: "notes", header: "ملاحظات" },
      ], rows);
    } catch (e) {
      toast.error("تعذّر تصدير CSV");
    }
  }

  const pagination = report?.pagination;

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="finance"
        title="كشف حساب"
        subtitle="كشف حساب مورد أو عميل — بصيغة حساباتي"
      />

      <Card>
        <CardBody>
          <FormGrid columns={2}>
            <FormField label="نوع الحساب">
              <Select
                value={partyType}
                onChange={(e) => {
                  setPartyType(e.target.value);
                  setParty(null);
                  setReport(null);
                }}
              >
                <option value="supplier">مورد</option>
                <option value="customer">عميل</option>
              </Select>
            </FormField>
            <FormField label={partyType === "supplier" ? "المورد" : "العميل"}>
              <PartyPicker
                value={party}
                onPick={(p) => {
                  if (!p || (partyType === "supplier" && p.type !== "supplier") || (partyType === "customer" && p.type !== "customer")) {
                    setParty(null);
                    return;
                  }
                  setParty(p);
                  setReport(null);
                }}
                placeholder={partyType === "supplier" ? "ابحث عن مورد…" : "ابحث عن عميل…"}
              />
              {party ? (
                <p style={{ marginTop: 6, fontSize: "0.9rem" }}>
                  المحدد: <strong>{party.name}</strong>
                </p>
              ) : null}
            </FormField>
            <FormField label="من تاريخ">
              <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
            </FormField>
            <FormField label="إلى تاريخ">
              <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
            </FormField>
          </FormGrid>

          <div className="ui-toolbar" style={{ marginTop: 16, gap: 8, flexWrap: "wrap" }}>
            <Button type="button" onClick={() => loadReport(1)} disabled={loading || !party}>
              {loading ? "جاري التحميل…" : "عرض"}
            </Button>
            <SecondaryButton type="button" onClick={handlePrint} disabled={!party}>طباعة</SecondaryButton>
            <SecondaryButton type="button" onClick={handlePdf} disabled={!party}>PDF</SecondaryButton>
            <SecondaryButton type="button" onClick={handleExcel} disabled={!party}>Excel</SecondaryButton>
            <SecondaryButton type="button" onClick={handleCsv} disabled={!party}>CSV</SecondaryButton>
          </div>
        </CardBody>
      </Card>

      {loading ? <p style={{ marginTop: 16 }}>جاري تحميل كشف الحساب…</p> : null}

      {!loading && report ? (
        <>
          <div style={{ marginTop: 16 }}>
            <AccountStatementView report={report} partyType={partyType} />
          </div>
          {pagination && pagination.totalPages > 1 ? (
            <div className="ui-toolbar" style={{ marginTop: 12 }}>
              <SecondaryButton
                type="button"
                disabled={page <= 1 || loading}
                onClick={() => loadReport(page - 1)}
              >
                السابق
              </SecondaryButton>
              <span>
                صفحة {pagination.page} من {pagination.totalPages} ({pagination.totalRows} سطر)
              </span>
              <SecondaryButton
                type="button"
                disabled={page >= pagination.totalPages || loading}
                onClick={() => loadReport(page + 1)}
              >
                التالي
              </SecondaryButton>
            </div>
          ) : null}
        </>
      ) : null}

      {!loading && report && !getDisplayRows(report).length ? (
        <p className="empty-msg">لا توجد حركات في الفترة المحددة.</p>
      ) : null}
    </div>
  );
}
