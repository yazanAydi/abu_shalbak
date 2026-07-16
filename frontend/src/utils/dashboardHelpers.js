/** @typedef {'critical'|'warning'|'info'} AlertSeverity */

import { parseServerDate, todayISO } from "./format.js";
import { addShopDays, shopTodayYmd } from "./shopTime.js";

export const VARIANCE_WARNING_NIS = 50;
export const VARIANCE_CRITICAL_NIS = 200;
export const SHIFT_LONG_HOURS = 12;

const ils = (n) => `\u20AA${Number(n).toFixed(2)}`;

/**
 * @param {number | null | undefined} n
 * @param {boolean} hasData
 */
export function formatMoney(n, hasData) {
  if (!hasData || n == null || Number.isNaN(Number(n))) return "—";
  return ils(Number(n));
}

/**
 * @param {number | null | undefined} n
 * @param {boolean} hasData
 */
export function formatCount(n, hasData) {
  if (!hasData || n == null || Number.isNaN(Number(n))) return "—";
  return String(Math.round(Number(n)));
}

/** @param {string | undefined} startIso */
export function shiftOpenDurationMs(startIso) {
  const d = parseServerDate(startIso);
  if (!d) return 0;
  return Math.max(0, Date.now() - d.getTime());
}

export function formatDurationAr(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h} ساعة و ${m} دقيقة`;
  if (m > 0) return `${m} دقيقة`;
  return "أقل من دقيقة";
}

/** @param {{ revenue?: number; cost?: number }[]} days */
export function chartDaysHaveActivity(days) {
  if (!Array.isArray(days) || days.length === 0) return false;
  return days.some((d) => (Number(d.revenue) || 0) > 0);
}

/**
 * @param {{ date: string; revenue: number; cost?: number; profit?: number }[]} days
 * @param {{ pointCount?: number }} [opts]
 */
export function buildDemoChartSeries(days, opts = {}) {
  const pointCount = opts.pointCount ?? 7;
  const span = Math.max(0, pointCount - 1);
  const base = Array.isArray(days) ? days.map((d) => ({ ...d })) : [];

  if (base.length === 0) {
    const out = [];
    for (let i = span; i >= 0; i--) {
      const date = addShopDays(shopTodayYmd(), -i) || todayISO();
      const dr = 800 + (span - i) * (pointCount > 7 ? 40 : 120);
      out.push({
        date,
        revenue: 0,
        label: date.slice(5),
        chartRevenue: dr,
      });
    }
    return { series: out, isDemo: true };
  }

  const isDemo = !chartDaysHaveActivity(base);
  if (!isDemo) {
    return {
      series: base.map((d) => ({
        ...d,
        label: d.date.slice(5),
        chartRevenue: Number(d.revenue) || 0,
      })),
      isDemo: false,
    };
  }

  return {
    series: base.map((d, i) => ({
      ...d,
      label: d.date.slice(5),
      chartRevenue: 1200 + i * (pointCount > 7 ? 35 : 95) + (i % 3) * 40,
    })),
    isDemo: true,
  };
}

/**
 * @param {object} input
 * @returns {Array<{ severity: AlertSeverity, title: string, body: string, link?: string, linkLabel?: string }>}
 */
export function buildDashboardAlerts(input) {
  /** @type {ReturnType<buildDashboardAlerts>} */
  const out = [];
  const {
    lastClosedShift,
    reconOverShort,
    refundCount,
    openShiftsWithDuration,
    lowStockCount,
    nearExpiryCount,
  } = input;

  if (lastClosedShift && lastClosedShift.variance != null) {
    const v = Number(lastClosedShift.variance);
    const av = Math.abs(v);
    if (av >= VARIANCE_CRITICAL_NIS) {
      out.push({
        severity: "critical",
        title: "⚠️ فرق نقدي كبير في آخر وردية",
        body: `${lastClosedShift.cashier_name || "كاشير"} — فرق ${v >= 0 ? "+" : ""}${ils(v)}`,
        link: `/shift-audit`,
        linkLabel: "عرض الورديات",
      });
    } else if (av >= VARIANCE_WARNING_NIS) {
      out.push({
        severity: "warning",
        title: "⚠️ تنبيه فرق نقدي",
        body: `${lastClosedShift.cashier_name || "كاشير"} — فرق ${v >= 0 ? "+" : ""}${ils(v)}`,
        link: `/shift-audit`,
        linkLabel: "عرض التفاصيل",
      });
    }
  }

  if (reconOverShort != null && !Number.isNaN(Number(reconOverShort))) {
    const o = Number(reconOverShort);
    const ao = Math.abs(o);
    if (ao >= VARIANCE_CRITICAL_NIS) {
      out.push({
        severity: "critical",
        title: "⚠️ تسوية نقدية اليوم — فرق حرج",
        body: `فرق العدّ: ${o >= 0 ? "+" : ""}${ils(o)}`,
        link: `/finance`,
        linkLabel: "المالية والتسوية",
      });
    } else if (ao >= VARIANCE_WARNING_NIS) {
      out.push({
        severity: "warning",
        title: "⚠️ تسوية نقدية — انتباه",
        body: `فرق العدّ: ${o >= 0 ? "+" : ""}${ils(o)}`,
        link: `/finance`,
        linkLabel: "المالية",
      });
    }
  }

  if (Number(refundCount) > 0) {
    out.push({
      severity: "info",
      title: "🛒 مرتجعات مسجّلة اليوم",
      body: `عدد عمليات الاسترجاع: ${refundCount}`,
      link: `/reports`,
      linkLabel: "لوحة التحكم",
    });
  }

  if (Array.isArray(openShiftsWithDuration)) {
    for (const s of openShiftsWithDuration) {
      const ms = shiftOpenDurationMs(s.start_time);
      const h = ms / (3600 * 1000);
      if (h >= SHIFT_LONG_HOURS) {
        out.push({
          severity: "warning",
          title: "⏱️ وردية مفتوحة لفترة طويلة",
          body: `${s.cashier_name || "كاشير"} — منذ ${formatDurationAr(ms)}`,
          link: `/shift-audit`,
          linkLabel: "تدقيق الورديات",
        });
      }
    }
  }

  if (Number(lowStockCount) > 0) {
    out.push({
      severity: "warning",
      title: "📦 مخزون منخفض",
      body: `${lowStockCount} منتج بمخزون ضعيف أو نافد`,
      link: `/manage-products`,
      linkLabel: "المنتجات",
    });
  }

  if (Number(nearExpiryCount) > 0) {
    out.push({
      severity: "warning",
      title: "⏳ صلاحية قريبة",
      body: `${nearExpiryCount} صنف أو دفعة ضمن فترة التنبيه`,
      link: `/expiry`,
      linkLabel: "تقرير الصلاحية",
    });
  }

  return out;
}
