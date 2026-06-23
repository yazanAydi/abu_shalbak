# لوحة التحكم اليومية (`/reports`)

## الغرض

لوحة للمدير والمحاسب تعرض **الورديات النشطة**، **ملخص اليوم**، **تنبيهات النقد**، **مخزون منخفض**، و**اتجاه 7 أيام** مع تحديث تلقائي كل 30 ثانية.

## الأقسام

1. **حالة الورديات** — من `GET /api/shifts?status=open` وتفاصيل كل وردية من `GET /api/shifts/:id` (النقد المتوقع في الدرج، عدد المبيعات، المدة).
2. **ملخص اليوم** — من `GET /api/reports/today` (إيراد صافٍ، عمليات، مرتجعات، قطع مباعة). بدون مبيعات تظهر «—» بدل 0.00.
3. **النقد والتنبيهات** — تجميع من:
   - آخر وردية مغلقة (`GET /api/shifts?status=closed`) والفرق فيها.
   - تسوية اليوم (`GET /api/finance/cash/reconciliation?date=YYYY-MM-DD`) إن وُجدت.
   - مرتجعات اليوم، وردية مفتوحة &gt; 12 ساعة، مخزون منخفض (`GET /api/reports/low-stock`).
4. **الاتجاهات** — `GET /api/reports/last-7-days` (صافي إيراد وتكلفة تقديرية من تكلفة المنتجات). إذا لا توجد مبيعات في الأسبوع، يُعرض **رسم تجريبي** مع إشعار صريح.

## واجهات API ذات الصلة

| المسار | الوصف |
|--------|--------|
| `GET /api/reports/today` | ملخص اليوم بصيغة موحّدة للوحة |
| `GET /api/reports/last-7-days` | مصفوفة `{ date, revenue, cost, profit, ... }` لكل يوم |
| `GET /api/reports/top-products?date=` | أفضل المنتجات لليوم |
| `GET /api/reports/low-stock?threshold=5` | منتجات بمخزون منخفض |
| `GET /api/shifts?status=open\|closed` | قائمة الورديات |
| `GET /api/shifts/:id` | تفاصيل وردية واحدة |
| `GET /api/finance/cash/reconciliation?date=` | تسوية نقدية ليوم محدد (404 إن لم تُسجَّل) |

## عتبات التنبيه (شيكل)

- فرق نقدي في وردية أو تسوية: **≥ 50** تحذير، **≥ 200** حرج (قابلة للتعديل في `frontend/src/utils/dashboardHelpers.js`).
- وردية مفتوحة **≥ 12 ساعة**: تحذير.

## الملفات

- الصفحة: `frontend/src/pages/DailyReport.jsx` + `DailyReport.css`
- مكوّنات: `ShiftStatusCard`, `TodaysSummary`, `CashAlerts`, `DashboardChart`
- مساعد: `frontend/src/utils/dashboardHelpers.js`
- تقارير خادم: `backend/routes/reports.js` (المسارات الجديدة أعلاه)

## ملاحظات

- الرسم البياني يستخدم **LineChart** (إيراد مقابل تكلفة).
- «آخر تحديث: منذ X ثانية» يُحدَّث كل ثانية للعرض فقط؛ جلب البيانات كل **30 ثانية**.
