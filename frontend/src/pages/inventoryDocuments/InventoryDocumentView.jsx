import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { dateOnly, qty as fmtQty } from "../../utils/format";
import { displayProductSku } from "../../utils/entityCodeDisplay";
import { printInventoryDocument, printInventoryDocumentHtml } from "../../utils/inventoryDocumentPrint";
import {
  PageHeader,
  Button,
  StatusPill,
  useToast,
} from "../../components/ui";
import { docConfig, reasonLabel } from "./constants";

export default function InventoryDocumentView({ docType }) {
  const cfg = docConfig(docType);
  const { id } = useParams();
  const toast = useToast();
  const navigate = useNavigate();
  const [doc, setDoc] = useState(null);
  const [store, setStore] = useState({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.get("/api/settings", { headers: getAuthHeaders() }).then(({ data }) => setStore(data || {})).catch(() => {});
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const { data } = await api.get(`${cfg.apiBase}/${id}`, { headers: getAuthHeaders() });
        if (!cancelled) setDoc(data);
      } catch (e) {
        if (!cancelled) {
          toast.error(e.response?.data?.error || "السند غير موجود");
          setDoc(null);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [cfg.apiBase, id]);

  if (loading) {
    return (
      <div className="office-page" dir="rtl" lang="ar">
        <p>جاري التحميل…</p>
      </div>
    );
  }

  if (!doc) {
    return (
      <div className="office-page" dir="rtl" lang="ar">
        <PageHeader title="السند غير موجود" actions={<Button variant="secondary" onClick={() => navigate(cfg.pathBase)}>رجوع</Button>} />
      </div>
    );
  }

  const reason = doc.reason_label || reasonLabel(docType, doc.reason);

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="inventory"
        title={`${cfg.title} رقم: ${doc.document_number}`}
        actions={
          <>
            <Button variant="secondary" onClick={() => navigate(cfg.pathBase)}>
              رجوع
            </Button>
            <Button
              icon="print"
              onClick={async () => {
                try {
                  const { data } = await api.get(`${cfg.apiBase}/${id}/print`, {
                    headers: getAuthHeaders(),
                    responseType: "text",
                  });
                  if (typeof data === "string" && data.includes("<html")) {
                    printInventoryDocumentHtml(data);
                    return;
                  }
                  printInventoryDocument(doc, store);
                } catch {
                  printInventoryDocument(doc, store);
                }
              }}
            >
              طباعة
            </Button>
          </>
        }
      />

      <dl className="pd-kv" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "0.35rem 1.5rem", marginBottom: "1.25rem" }}>
        <dt>التاريخ</dt>
        <dd>{dateOnly(doc.document_date)}</dd>
        <dt>السبب</dt>
        <dd>{reason}</dd>
        <dt>أنشأه</dt>
        <dd>{doc.created_by_name || "—"}</dd>
        <dt>الحالة</dt>
        <dd><StatusPill tone="green">مكتمل</StatusPill></dd>
        {doc.notes ? (
          <>
            <dt>الملاحظات</dt>
            <dd>{doc.notes}</dd>
          </>
        ) : null}
      </dl>

      <div className="ui-table-wrap">
        <table className="ui-table">
          <thead>
            <tr>
              <th>المنتج</th>
              <th>الرقم</th>
              <th>الباركود</th>
              <th>الوحدة</th>
              <th>الكمية</th>
              <th>التحويل</th>
              <th>الكمية الأساسية</th>
            </tr>
          </thead>
          <tbody>
            {(doc.items || []).map((it) => (
              <tr key={it.id}>
                <td>{it.product_name || it.product_name_snapshot}</td>
                <td>{displayProductSku(it.sku || it.sku_snapshot)}</td>
                <td>{it.barcode || it.barcode_snapshot || "—"}</td>
                <td>{it.unit_name || it.unit_name_snapshot || "—"}</td>
                <td className="num">
                  {fmtQty(it.quantity)} {it.unit_name || it.unit_name_snapshot || ""}
                </td>
                <td className="num">{fmtQty(it.conversion_used ?? it.conversion_to_base)}</td>
                <td className="num">{fmtQty(it.base_quantity)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
