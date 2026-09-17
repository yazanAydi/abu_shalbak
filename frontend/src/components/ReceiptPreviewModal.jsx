import { useEffect, useMemo, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { apiErrorMessage } from "../utils/apiError";
import { loadStoreSettings } from "../utils/loadStoreSettings";
import { injectFrontendLogo, printReceipt } from "../utils/printReceipt";
import { buildSalesInvoicePrintHtml, printSalesInvoiceDoc } from "../utils/saleInvoicePrint";
import { Button, Modal } from "./ui";
import "./ReceiptPreviewModal.css";

function invoiceLabel(invoice) {
  if (!invoice) return "";
  return invoice.invoice_no || (invoice.source_id != null ? `#${invoice.source_id}` : "");
}

const PREVIEW_CSS = `<style id="receipt-preview-screen">html,body{width:100% !important;min-height:0 !important;height:auto !important;background:#fff;}body{display:flex;justify-content:center;} .receipt{margin:8px auto;}</style>`;

function htmlForScreenPreview(fullHtml) {
  if (!fullHtml) return "";
  if (fullHtml.includes("id=\"receipt-preview-screen\"")) return fullHtml;
  if (fullHtml.includes("</head>")) return fullHtml.replace("</head>", `${PREVIEW_CSS}</head>`);
  return PREVIEW_CSS + fullHtml;
}

function fitIframeToContent(iframe) {
  if (!iframe) return;
  try {
    const doc = iframe.contentDocument;
    const height = Math.max(
      doc?.documentElement?.scrollHeight || 0,
      doc?.body?.scrollHeight || 0,
      480
    );
    iframe.style.height = `${height + 12}px`;
  } catch {
    iframe.style.height = "640px";
  }
}

export default function ReceiptPreviewModal({ open, employeeId, invoice, onClose }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [store, setStore] = useState({});
  const [payload, setPayload] = useState(null);

  useEffect(() => {
    if (!open) {
      setLoading(false);
      setError("");
      setPayload(null);
      return undefined;
    }
    let cancelled = false;
    const sourceType = invoice?.source_type;
    const sourceId = invoice?.source_id;
    if (!employeeId || !sourceType || !sourceId) {
      setError("الفاتورة غير صالحة");
      return undefined;
    }

    setLoading(true);
    setError("");
    setPayload(null);
    (async () => {
      try {
        const [{ data }, settings] = await Promise.all([
          api.get(`/api/employees/${employeeId}/invoices/${sourceType}/${sourceId}/receipt`, {
            headers: getAuthHeaders(),
          }),
          loadStoreSettings(),
        ]);
        if (cancelled) return;
        setStore(settings || {});
        setPayload(data);
      } catch (e) {
        if (!cancelled) setError(apiErrorMessage(e, "فشل تحميل الإيصال"));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [open, employeeId, invoice?.source_type, invoice?.source_id]);

  const html = useMemo(() => {
    if (!payload) return "";
    if (payload.kind === "sales_invoice" && payload.invoice) {
      return htmlForScreenPreview(buildSalesInvoicePrintHtml(payload.invoice, store));
    }
    if (payload.receipt_html) {
      return htmlForScreenPreview(injectFrontendLogo(payload.receipt_html, store.logo_url));
    }
    return "";
  }, [payload, store]);

  const titleNo = payload?.invoice_no || invoiceLabel(invoice);
  const isA4 = payload?.kind === "sales_invoice";

  function handlePrint() {
    if (!payload) return;
    if (payload.kind === "sales_invoice" && payload.invoice) {
      printSalesInvoiceDoc(payload.invoice, store);
      return;
    }
    printReceipt(payload, { logoUrl: store.logo_url });
  }

  return (
    <Modal
      open={open}
      title={titleNo ? `إيصال ${titleNo}` : "الإيصال"}
      onClose={onClose}
      size={isA4 ? "lg" : "sm"}
      className="receipt-preview-modal"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            إغلاق
          </Button>
          <Button icon="print" onClick={handlePrint} disabled={loading || !html}>
            طباعة
          </Button>
        </>
      }
    >
      {loading ? <p className="receipt-preview__status">جاري تحميل الإيصال…</p> : null}
      {error ? <p className="receipt-preview__status">{error}</p> : null}
      {!loading && !error && html ? (
        <div className={isA4 ? "receipt-preview" : "receipt-preview receipt-preview--thermal"}>
          <iframe
            title={titleNo ? `إيصال ${titleNo}` : "الإيصال"}
            srcDoc={html}
            sandbox="allow-same-origin"
            onLoad={(e) => fitIframeToContent(e.currentTarget)}
          />
        </div>
      ) : null}
    </Modal>
  );
}
