import fs from "fs";
import path from "path";

/** Business modules discovered from backend/routes. */
export const MODULES = [
  { id: "auth", feature: "auth", screen: "تسجيل الدخول" },
  { id: "settings", feature: "settings", screen: "الإعدادات" },
  { id: "products", feature: "inventory", screen: "المنتجات" },
  { id: "purchases", feature: "purchases", screen: "المشتريات" },
  { id: "purchase-vat", feature: "purchase-vat", screen: "فاتورة مشتريات" },
  { id: "purchase-returns", feature: "purchase-returns", screen: "مرتجعات الموردين" },
  { id: "suppliers", feature: "suppliers", screen: "الموردون" },
  { id: "vouchers", feature: "vouchers", screen: "سندات القبض والصرف" },
  { id: "warehouses", feature: "warehouses", screen: "المستودعات" },
  { id: "stock-count", feature: "stock-count", screen: "جرد المخزون" },
  { id: "inventory-issues", feature: "inventory-issues", screen: "سند إخراج" },
  { id: "inventory-receipts", feature: "inventory-receipts", screen: "سند إدخال" },
  { id: "expiry", feature: "expiry", screen: "الصلاحية" },
  { id: "costing", feature: "costing", screen: "المنتجات / التكلفة" },
  { id: "pos", feature: "pos", screen: "نقطة البيع" },
  { id: "weight", feature: "weight", screen: "نقطة البيع / الميزان" },
  { id: "promotions", feature: "promotions", screen: "التسويق" },
  { id: "shifts", feature: "shifts", screen: "الورديات" },
  { id: "on-account", feature: "on-account", screen: "الذمة" },
  { id: "credit-limit", feature: "credit-limit", screen: "حد الذمة" },
  { id: "advances", feature: "advances", screen: "السلف" },
  { id: "refunds", feature: "pos", screen: "المرتجعات" },
  { id: "suspended-sales", feature: "suspended-sales", screen: "البيع المعلق" },
  { id: "print", feature: "print", screen: "الإيصال" },
  { id: "customers", feature: "customers", screen: "العملاء" },
  { id: "sales-invoices", feature: "sales-invoices", screen: "فواتير المبيعات" },
  { id: "deliveries", feature: "deliveries", screen: "التوصيل" },
  { id: "expenses", feature: "permissions", screen: "المصروفات" },
  { id: "finance", feature: "finance", screen: "المراقبة المالية" },
  { id: "business-day", feature: "business-day", screen: "اليوم التشغيلي" },
  { id: "bakery", feature: "bakery", screen: "المخبز" },
  { id: "bakery-supplies", feature: "bakery-supplies", screen: "مواد المخبز" },
  { id: "attendance", feature: "attendance", screen: "الدوام" },
  { id: "payroll", feature: "payroll", screen: "الرواتب" },
  { id: "banks", feature: "banks", screen: "البنوك" },
  { id: "currencies", feature: "currencies", screen: "العملات" },
  { id: "permissions", feature: "permissions", screen: "الصلاحيات" },
  { id: "faults", feature: "fault", screen: "قاعدة الأعطال المنفصلة" },
];

export const NOT_APPLICABLE = [
  {
    id: "telegram",
    reason: "الموافقات تُنفَّذ من واجهة المكتب. لا يُستخدم تيليجرام الحقيقي في المحاكاة.",
  },
  {
    id: "face-kiosk",
    reason: "لا توجد كاميرا أو واصفات وجه. دوام المخبز يُسجَّل ببصمة يدوية عبر الواجهة البرمجية.",
  },
  {
    id: "hesabati-import",
    reason: "استيراد حساباتي ليس حركة يوم تشغيل. لم يُدرَج في مجموعة البيانات التجريبية.",
  },
  {
    id: "physical-printer",
    reason: "الطابعة الحرارية غير مستخدمة. الإيصال يُحفظ كملف في وضع الاختبار.",
  },
];

function coverageRows(results) {
  return MODULES.map((mod) => {
    const rows = results.filter((row) => row.feature === mod.feature);
    let status = "not covered";
    if (rows.some((row) => row.status === "FAIL")) status = "FAIL";
    else if (rows.some((row) => row.status === "PASS")) status = "PASS";
    else if (rows.some((row) => row.status === "BLOCKED")) status = "BLOCKED";
    return {
      module: mod.id,
      screen: mod.screen,
      status,
      scenarios: rows.map((row) => row.scenario),
    };
  });
}

export function writeReport({ reportDir, results, meta, reportName = "report" }) {
  fs.mkdirSync(reportDir, { recursive: true });
  const counts = { PASS: 0, FAIL: 0, BLOCKED: 0 };
  for (const row of results) {
    if (counts[row.status] != null) counts[row.status] += 1;
  }
  const coverage = coverageRows(results);
  const payload = { meta, counts, results, coverage, notApplicable: NOT_APPLICABLE };
  fs.writeFileSync(path.join(reportDir, `${reportName}.json`), JSON.stringify(payload, null, 2));

  const lines = [];
  lines.push("# تقرير محاكاة المتجر التجريبي");
  lines.push("");
  lines.push(`النتيجة: ${counts.FAIL ? "FAIL" : "PASS"} — نجح ${counts.PASS}، فشل ${counts.FAIL}، موقوف ${counts.BLOCKED}.`);
  lines.push("");
  lines.push("## التعريف");
  lines.push("");
  lines.push(`- قاعدة التطوير السابقة: \`${meta.devDatabase}\``);
  lines.push(`- تصنيفها: ${meta.devClassification}`);
  lines.push(`- النسخة الاحتياطية: \`${meta.backupPath || "لم تُنشأ"}\``);
  lines.push(`- قاعدة العرض النشطة للمحاكاة: \`${meta.demoDatabase}\``);
  lines.push(`- قاعدة الأعطال: \`${meta.faultDatabase}\``);
  lines.push(`- نطاق التاريخ في الواجهة: ${meta.uiRange}`);
  lines.push("");
  lines.push("## الحسابات");
  lines.push("");
  for (const account of meta.accounts || []) {
    lines.push(`- ${account.role} / ${account.portal}: \`${account.username}\` / \`${account.password}\``);
  }
  lines.push("");
  lines.push("## السيناريوهات");
  lines.push("");
  for (const row of results) {
    const diff = row.diff ? ` (الفرق ${row.diff})` : "";
    lines.push(
      `- ${row.status} ${row.scenario}: expected ${row.expected}; actual ${row.actual}${diff}` +
        (row.classification ? ` [${row.classification}]` : "") +
        (row.screen ? ` — ${row.screen}` : "")
    );
  }
  lines.push("");
  lines.push("## التغطية");
  lines.push("");
  for (const row of coverage) {
    lines.push(`- ${row.status} ${row.module} — ${row.screen}`);
  }
  lines.push("");
  lines.push("## غير منطبق");
  lines.push("");
  for (const row of NOT_APPLICABLE) {
    lines.push(`- ${row.id}: ${row.reason}`);
  }
  lines.push("");
  lines.push("## التجول في الواجهة");
  lines.push("");
  for (const step of meta.walkthrough || []) {
    lines.push(`- ${step.screen} / ${step.record}: ${step.expect}`);
  }
  lines.push("");
  lines.push("## الأوامر");
  lines.push("");
  lines.push("```powershell");
  lines.push("npm run demo:store -- --reset");
  lines.push("npm run demo:verify");
  lines.push("npm run demo:restore");
  lines.push("```");
  if (meta.restoreCommand) {
    lines.push("");
    lines.push(meta.restoreCommand);
  }
  fs.writeFileSync(path.join(reportDir, `${reportName}.md`), lines.join("\n"), "utf8");
  return {
    counts,
    coverage,
    jsonPath: path.join(reportDir, `${reportName}.json`),
    mdPath: path.join(reportDir, `${reportName}.md`),
  };
}
