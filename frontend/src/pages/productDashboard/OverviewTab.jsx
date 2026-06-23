import { Card, CardBody, StatCard, StatusBadge } from "../../components/ui";
import { ils, num } from "../../utils/format";
import { useProductTab } from "./useProductTab";
import { TabState, expiryBadge } from "./shared";

export default function OverviewTab({ productId }) {
  const { data, loading, error } = useProductTab(`/api/products/${productId}/overview`);

  return (
    <TabState loading={loading} error={error}>
      {data ? (
        <div className="pd-overview">
          <div className="ui-stat-grid pd-cards">
            <StatCard label="المخزون الحالي" value={num(data.inventory.current_stock, 0)} icon="inventory" tone={data.inventory.low_stock ? "orange" : "teal"} alert={data.inventory.out_of_stock} />
            <StatCard label="قيمة المخزون" value={ils(data.inventory.inventory_value)} icon="finance" tone="teal" />
            <StatCard label="سعر البيع الحالي" value={ils(data.pricing.current_price)} icon="finance" tone="green" />
            <StatCard label="متوسط التكلفة" value={ils(data.pricing.average_cost)} icon="purchases" tone="orange" />
            <StatCard label="هامش الربح" value={`${num(data.pricing.margin_pct)}%`} icon="finance" tone="green" />
          </div>

          <div className="pd-overview-grid">
            <Card>
              <CardBody>
                <h3 className="pd-section-title">المعلومات الأساسية</h3>
                <dl className="pd-defs">
                  <div><dt>الاسم</dt><dd>{data.basic.name}</dd></div>
                  {data.basic.name_en ? <div><dt>الاسم (EN)</dt><dd>{data.basic.name_en}</dd></div> : null}
                  <div><dt>الباركود</dt><dd>{data.basic.barcode}</dd></div>
                  <div><dt>SKU</dt><dd>{data.basic.sku || "—"}</dd></div>
                  <div><dt>التصنيف</dt><dd>{data.basic.category || "—"}</dd></div>
                  <div><dt>الوحدة</dt><dd>{data.basic.unit || "—"}</dd></div>
                  <div><dt>نسبة الضريبة</dt><dd>{data.basic.tax_rate != null ? `${num(Number(data.basic.tax_rate) * 100)}%` : "—"}</dd></div>
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <h3 className="pd-section-title">التسعير والتكلفة</h3>
                <dl className="pd-defs">
                  <div><dt>سعر البيع الحالي</dt><dd>{ils(data.pricing.current_price)}</dd></div>
                  <div><dt>متوسط التكلفة</dt><dd>{ils(data.pricing.average_cost)}</dd></div>
                  <div><dt>الحد الأدنى للسعر</dt><dd>{data.pricing.min_price != null ? ils(data.pricing.min_price) : "—"}</dd></div>
                  <div><dt>الحد الأقصى للسعر</dt><dd>{data.pricing.max_price != null ? ils(data.pricing.max_price) : "—"}</dd></div>
                  <div><dt>هامش الربح</dt><dd>{num(data.pricing.margin_pct)}%</dd></div>
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <h3 className="pd-section-title">الصلاحية والتنبيهات</h3>
                <dl className="pd-defs">
                  <div><dt>تاريخ الصلاحية</dt><dd>{data.expiry.expiry_date || "—"}</dd></div>
                  <div>
                    <dt>حالة الصلاحية</dt>
                    <dd>
                      {(() => {
                        const b = expiryBadge(data.expiry.days_until_expiry);
                        return b ? <StatusBadge tone={b.tone} noDot>{b.label}</StatusBadge> : "—";
                      })()}
                    </dd>
                  </div>
                  <div>
                    <dt>تنبيه المخزون</dt>
                    <dd>
                      {data.inventory.out_of_stock ? (
                        <StatusBadge tone="red" noDot>نفد المخزون</StatusBadge>
                      ) : data.inventory.low_stock ? (
                        <StatusBadge tone="orange" noDot>مخزون منخفض</StatusBadge>
                      ) : (
                        <StatusBadge tone="green" noDot>المخزون جيد</StatusBadge>
                      )}
                    </dd>
                  </div>
                </dl>
              </CardBody>
            </Card>

            <Card>
              <CardBody>
                <h3 className="pd-section-title">مواقع المستودعات</h3>
                {data.warehouses && data.warehouses.length > 0 ? (
                  <div className="ui-table-wrap pd-sticky-table">
                    <table className="ui-table">
                      <thead><tr><th>المستودع</th><th>الكود</th><th>الكمية</th></tr></thead>
                      <tbody>
                        {data.warehouses.map((w) => (
                          <tr key={w.warehouse_id}>
                            <td>{w.warehouse_name}</td>
                            <td>{w.code || "—"}</td>
                            <td className="num">{num(w.quantity, 0)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <p className="pd-muted">لا توجد كميات موزعة على المستودعات.</p>
                )}
              </CardBody>
            </Card>
          </div>
        </div>
      ) : null}
    </TabState>
  );
}
