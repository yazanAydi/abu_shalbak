import { A4_PRINT_SHEET_CSS, PRINT_BRANDING_CSS, buildPrintBrandingHtml } from "./printBranding";
import { buildSalesInvoicePrintHtml } from "./saleInvoicePrint";
import { buildVoucherDocPrintHtml } from "./voucherDocPrint";
import { buildInventoryDocumentPrintHtml } from "./inventoryDocumentPrint";

beforeEach(() => {
  localStorage.setItem("office.user", JSON.stringify({ username: "admin" }));
});

describe("A4 print templates use compact sheet CSS", () => {
  test("sales invoice keeps barcode and compact sheet rules", () => {
    const html = buildSalesInvoicePrintHtml(
      {
        invoice_no: 12,
        invoice_date: "2026-09-17",
        customer_name: "عميل الاختبار",
        status: "posted",
        total: 50,
        items: [
          {
            name: "خبز عربي",
            barcode: "8802000001",
            unit_name: "حبة",
            quantity: 10,
            bonus_quantity: 1,
            unit_price: 5,
            line_total: 50,
          },
        ],
      },
      {}
    );
    expect(html).toContain("الباركود");
    expect(html).toContain("8802000001");
    expect(html).toMatch(/@page\s*\{\s*margin:\s*9mm;/);
    expect(html).toMatch(/max-height:\s*58px/);
    expect(html).toMatch(/font-size:\s*10\.5pt/);
    expect(html).toContain("totals-wrap");
    expect(html).toContain("50.00");
  });

  test("voucher print uses compact sheet CSS", () => {
    const html = buildVoucherDocPrintHtml(
      {
        voucher_type: "payment",
        voucher_no: 4,
        voucher_date: "2026-09-17",
        status: "posted",
        total_amount: 120,
        supplier_name: "مورد",
        lines: [{ line_type: "cash", amount_nis: 120, currency: "ILS" }],
      },
      {}
    );
    expect(html).toContain("سند صرف");
    expect(html).toContain("120.00");
    expect(html).toMatch(/@page\s*\{\s*margin:\s*9mm;/);
    expect(html).toMatch(/max-height:\s*58px/);
    expect(html).toContain("totals-wrap");
  });

  test("inventory document print keeps barcode and compact sheet CSS", () => {
    const html = buildInventoryDocumentPrintHtml(
      {
        document_type: "receipt",
        document_number: "IN-1",
        document_date: "2026-09-17",
        created_by_name: "admin",
        items: [
          {
            product_name: "طحين",
            sku: "1001",
            barcode: "6291000001",
            unit_name: "كغم",
            quantity: 25,
            base_quantity: 25,
          },
        ],
      },
      {}
    );
    expect(html).toContain("الباركود");
    expect(html).toContain("6291000001");
    expect(html).toMatch(/@page\s*\{\s*margin:\s*9mm;/);
    expect(html).toMatch(/max-height:\s*58px/);
    expect(html).toContain("25");
  });

  (process.env.DUMP_A4_PRINT === "1" ? test : test.skip)("dumps A4 print fixtures when DUMP_A4_PRINT=1", () => {
    const fs = require("fs");
    const path = require("path");
    const outDir = path.join(__dirname, "..", "..", "..", "tmp", "a4-print");
    fs.mkdirSync(outDir, { recursive: true });
    const logoPath = path.join(__dirname, "..", "assets", "store-logo.png");
    const logoUrl = `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`;
    const store = {
      store_name_ar: "مخبز و سوبر ماركت الطيرة ابو شلبك",
      store_phone: "022980903",
      store_license: "مشتغل مرخص 562536680",
      logoUrl,
    };
    const branding = buildPrintBrandingHtml(store);
    const longRows = Array.from({ length: 45 }, (_, i) =>
      `<tr><td>${i + 1}</td><td>صنف تقرير طويل الاسم للطباعة ${i + 1}</td><td class="num">${(1000 + i).toFixed(2)}</td></tr>`
    ).join("");
    const reportHtml = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl"><head><meta charset="utf-8" /><title>تقرير</title>
<style>@page { size: A4; } ${A4_PRINT_SHEET_CSS} ${PRINT_BRANDING_CSS} th { background: #f0f0f0; }</style>
</head><body>${branding}<h1>تقرير مبيعات</h1>
<p class="meta"><strong>الفترة:</strong> كل الفترات</p>
<table><thead><tr><th>#</th><th>الصنف</th><th>المبلغ</th></tr></thead><tbody>${longRows}</tbody></table>
</body></html>`;
    const statementHtml = `<!DOCTYPE html>
<html lang="ar-u-nu-latn" dir="rtl"><head><meta charset="utf-8" /><title>كشف</title>
<style>@page { size: A4 landscape; } ${A4_PRINT_SHEET_CSS} ${PRINT_BRANDING_CSS} th { background: #1f3a5f; color: #fff; }</style>
</head><body>${branding}<h1>كشف حساب المورد</h1>
<div class="meta"><div><strong>المورد:</strong> مورد الاختبار</div><div><strong>الفترة:</strong> كل الفترات</div></div>
<table><thead><tr><th>التاريخ</th><th>البيان</th><th>مدين</th><th>دائن</th><th>الرصيد</th></tr></thead>
<tbody>${Array.from({ length: 20 }, (_, i) => `<tr><td>17/09/26</td><td>فاتورة ${i + 1}</td><td class="num">1,234.56</td><td class="num">—</td><td class="num">${(2000 + i).toFixed(2)}</td></tr>`).join("")}</tbody>
</table></body></html>`;
    fs.writeFileSync(path.join(outDir, "sales-invoice.html"), buildSalesInvoicePrintHtml({
      invoice_no: 12, invoice_date: "2026-09-17", customer_name: "عميل الاختبار", status: "posted", total: 50,
      items: [{ name: "خبز عربي طويل الأمد", barcode: "8802000001", unit_name: "حبة", quantity: 10, bonus_quantity: 1, unit_price: 5, line_total: 50 }],
    }, store));
    fs.writeFileSync(path.join(outDir, "inventory.html"), buildInventoryDocumentPrintHtml({
      document_type: "receipt", document_number: "IN-1", document_date: "2026-09-17", created_by_name: "admin",
      items: [{ product_name: "طحين أبيض فاخر", sku: "1001", barcode: "6291000001", unit_name: "كغم", quantity: 25, base_quantity: 25 }],
    }, store));
    fs.writeFileSync(path.join(outDir, "long-report.html"), reportHtml);
    fs.writeFileSync(path.join(outDir, "landscape-statement.html"), statementHtml);
  });
});
