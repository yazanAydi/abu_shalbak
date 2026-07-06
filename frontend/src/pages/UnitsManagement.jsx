import { useCallback, useEffect, useRef, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import ProductPicker from "../components/ProductPicker";
import ProductUnitsSection from "./productDashboard/ProductUnitsSection";
import {
  PageHeader,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  DataTable,
  SecondaryButton,
  Input,
  FormField,
} from "../components/ui";

// Normalize both ProductPicker shapes (search row vs. barcode-lookup response)
// into a flat { id, name, stock } for the header summary.
function normalizePicked(p) {
  if (!p) return null;
  const product = p.product ?? p;
  const id = product.id ?? p.id;
  if (!id) return null;
  return {
    id,
    name: product.name ?? p.name ?? "",
    stock: product.stock ?? p.stock ?? null,
  };
}

function formatUnitsSummary(units) {
  if (!Array.isArray(units) || units.length === 0) return "—";
  return units
    .filter((u) => Number(u.conversion_to_base) !== 1 || units.length === 1)
    .map((u) => `${u.unit_name} ×${u.conversion_to_base}`)
    .join(" · ");
}

export default function UnitsManagement() {
  const [selected, setSelected] = useState(null);
  const editorRef = useRef(null);
  const [catalog, setCatalog] = useState([]);
  const [catalogTotal, setCatalogTotal] = useState(0);
  const [catalogSearch, setCatalogSearch] = useState("");
  const [loadingCatalog, setLoadingCatalog] = useState(true);
  const [catalogErr, setCatalogErr] = useState(null);

  const loadCatalog = useCallback(async () => {
    setLoadingCatalog(true);
    setCatalogErr(null);
    try {
      const params = {};
      const term = catalogSearch.trim();
      if (term) params.search = term;
      const { data } = await api.get("/api/products/units/catalog", {
        headers: getAuthHeaders(),
        params,
      });
      setCatalog(Array.isArray(data.rows) ? data.rows : []);
      setCatalogTotal(Number(data.total) || 0);
    } catch (e) {
      const status = e.response?.status;
      if (status === 404) {
        setCatalogErr("تعذّر تحميل القائمة — أعد تشغيل الخادم (npm run start:api)");
      } else {
        setCatalogErr(e.response?.data?.error || e.message || "تعذّر تحميل قائمة الوحدات");
      }
      setCatalog([]);
      setCatalogTotal(0);
    } finally {
      setLoadingCatalog(false);
    }
  }, [catalogSearch]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      loadCatalog();
    }, catalogSearch.trim() ? 300 : 0);
    return () => window.clearTimeout(timer);
  }, [loadCatalog, catalogSearch]);

  useEffect(() => {
    if (selected && editorRef.current) {
      editorRef.current.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, [selected?.id]);

  function handlePick(p) {
    const norm = normalizePicked(p);
    if (norm) setSelected(norm);
  }

  function selectFromCatalog(row) {
    setSelected({
      id: row.product_id,
      name: row.product_name,
      stock: null,
    });
  }

  const catalogColumns = [
    {
      key: "product_name",
      header: "المنتج",
      render: (row) => <strong>{row.product_name}</strong>,
    },
    {
      key: "product_barcode",
      header: "باركود",
      render: (row) => <code>{row.product_barcode}</code>,
    },
    {
      key: "units",
      header: "الوحدات",
      render: (row) => (
        <span style={{ color: "var(--office-panel-muted)" }}>
          {formatUnitsSummary(row.units)}
        </span>
      ),
    },
    {
      key: "unit_count",
      header: "العدد",
      align: "center",
      render: (row) => row.unit_count,
    },
    {
      key: "actions",
      header: "",
      align: "left",
      render: (row) => (
        <SecondaryButton
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            selectFromCatalog(row);
          }}
        >
          تعديل
        </SecondaryButton>
      ),
    },
  ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="products"
        title="الوحدات"
        subtitle="عرّف وحدات التعبئة لكل منتج: كم حبة في الصندوق، الربطة، الكرتونة…"
      />

      <Card style={{ overflow: "visible", position: "relative", zIndex: 5 }}>
        <CardBody>
          <p style={{ marginTop: 0, color: "var(--office-panel-muted)" }}>
            امسح باركود المنتج (الحبة) أو ابحث بالاسم، ثم أضف وحداته الأكبر مثل
            الصندوق مع باركوده ومعامل التحويل (كم حبة يحتوي).
          </p>
          <ProductPicker onPick={handlePick} />
        </CardBody>
      </Card>

      {selected ? (
        <div ref={editorRef}>
          <Card style={{ marginTop: "1rem" }}>
            <CardBody>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  alignItems: "center",
                  flexWrap: "wrap",
                  gap: "0.5rem",
                  marginBottom: "0.75rem",
                }}
              >
                <strong style={{ fontSize: "1.05rem" }}>{selected.name}</strong>
                {selected.stock != null ? (
                  <span style={{ color: "var(--office-panel-muted)" }}>
                    المخزون الحالي: {selected.stock} (بوحدة الأساس)
                  </span>
                ) : null}
              </div>
              <ProductUnitsSection
                productId={selected.id}
                onChanged={loadCatalog}
              />
            </CardBody>
          </Card>
        </div>
      ) : null}

      <Card style={{ marginTop: "1rem" }}>
        <CardHeader
          title="منتجات ذات وحدات تعبئة"
          subtitle={
            catalogTotal > 0
              ? `${catalogTotal} منتج`
              : "المنتجات التي عرّفت لها صندوق أو ربطة أو غيرها"
          }
        />
        <CardBody flush>
          <div style={{ padding: "0 1.25rem 1rem" }}>
            <FormField label="بحث في القائمة">
              <Input
                value={catalogSearch}
                onChange={(e) => setCatalogSearch(e.target.value)}
                placeholder="اسم المنتج أو الباركود…"
              />
            </FormField>
          </div>
          {catalogErr ? (
            <p
              style={{
                color: "var(--office-danger)",
                margin: "0 1.25rem 1rem",
              }}
            >
              {catalogErr}
            </p>
          ) : null}
          <DataTable
            columns={catalogColumns}
            rows={catalog}
            loading={loadingCatalog}
            rowKey={(row) => row.product_id}
            onRowClick={selectFromCatalog}
            empty="لا توجد وحدات تعبئة بعد"
            emptyIcon="products"
            emptyHint="ابحث عن منتج أعلاه وأضف له أول وحدة (مثل صندوق)."
          />
        </CardBody>
      </Card>
    </div>
  );
}
