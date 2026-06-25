import { useEffect, useState, useCallback } from "react";
import api from "../apiClient";
import AccountStatementView from "./AccountStatementView";
import StatementHistoryImportModal from "./StatementHistoryImportModal";
import { printAccountStatement, downloadAccountStatementExcel } from "../utils/accountStatementPrint";
import { exportToCsv } from "../utils/reportExport";
import { getDisplayRows } from "./AccountStatementView";
import { Button, Modal, SecondaryButton } from "./ui";

/**
 * @param {{
 *   open: boolean,
 *   partyType: "supplier" | "customer",
 *   party: { id: number, name: string } | null,
 *   onClose: () => void,
 * }} props
 */
export default function HesabatiStatementModal({ open, partyType, party, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);
  const [historyImportOpen, setHistoryImportOpen] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  const loadReport = useCallback(async () => {
    if (!party?.id) return;
    setLoading(true);
    setError(null);
    try {
      const base = partyType === "supplier" ? "/api/suppliers" : "/api/customers";
      const { data } = await api.get(`${base}/${party.id}/statement`);
      setReport(data);
    } catch (e) {
      setError(e.response?.data?.error || e.message || "تعذّر تحميل التقرير");
    } finally {
      setLoading(false);
    }
  }, [party?.id, partyType]);

  useEffect(() => {
    if (!open || !party?.id) {
      setReport(null);
      setError(null);
      return;
    }
    loadReport();
  }, [open, party?.id, partyType, reloadKey, loadReport]);

  async function handlePrint() {
    if (!report) return;
    printAccountStatement(report, partyType);
  }

  function handleCsv() {
    if (!report) return;
    const rows = getDisplayRows(report);
    exportToCsv(`${partyType}-statement-${party?.id}`, [
      { key: "line_no", header: "الرقم" },
      { key: "description", header: "البيان" },
      { key: "date", header: "التاريخ" },
      { key: "debit", header: "مدين" },
      { key: "credit", header: "دائن" },
      { key: "balance_formatted", header: "الرصيد" },
      { key: "notes", header: "ملاحظات" },
    ], rows);
  }

  async function handleExcel() {
    if (!party?.id) return;
    await downloadAccountStatementExcel(api, {
      partyType,
      partyId: party.id,
      from: report?.date_from,
      to: report?.date_to,
    });
  }

  return (
    <>
      <Modal
        open={open}
        title={party ? `عرض التقرير: ${party.name}` : "عرض التقرير"}
        onClose={onClose}
        size="lg"
        footer={
          <>
            <SecondaryButton type="button" onClick={() => setHistoryImportOpen(true)}>
              استيراد كشف حساب قديم
            </SecondaryButton>
            {report ? (
              <>
                <SecondaryButton type="button" onClick={handlePrint}>طباعة</SecondaryButton>
                <SecondaryButton type="button" onClick={handlePrint}>PDF</SecondaryButton>
                <SecondaryButton type="button" onClick={handleExcel}>Excel</SecondaryButton>
                <SecondaryButton type="button" onClick={handleCsv}>CSV</SecondaryButton>
              </>
            ) : null}
            <Button type="button" onClick={onClose}>إغلاق</Button>
          </>
        }
      >
        {loading ? <p>جاري التحميل…</p> : null}
        {error ? <p style={{ color: "var(--office-danger)" }}>{error}</p> : null}
        {report ? <AccountStatementView report={report} partyType={partyType} /> : null}
      </Modal>

      <StatementHistoryImportModal
        open={historyImportOpen}
        partyType={partyType}
        party={party}
        onClose={() => setHistoryImportOpen(false)}
        onSuccess={() => setReloadKey((k) => k + 1)}
      />
    </>
  );
}
