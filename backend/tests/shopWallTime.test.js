import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildReceiptText } from "../utils/receipt.js";
import { formatShopWall, shopDaySqlBounds, SHOP_TZ } from "../utils/shopTime.js";
import { dayBefore } from "../utils/supplierLedger.js";
import { parseStatementDate } from "../utils/statementHistoryImport.js";

const shopTimeUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "utils", "shopTime.js")
).href;

function wallOnHost(tz) {
  const script = `
    import { formatShopWall, SHOP_TZ } from ${JSON.stringify(shopTimeUrl)};
    const wall = formatShopWall("2026-07-10 21:00:00");
    console.log(JSON.stringify({ zone: SHOP_TZ, dateTime: wall && wall.dateTime }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, TZ: tz, SHOP_TZ: "" },
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || "host zone process failed");
  }
  return JSON.parse(result.stdout.trim());
}

const receiptOpts = {
  timestamp: "2026-07-10 21:00:00",
  lines: [],
  subtotal: 0,
  tax: 0,
  discount: 0,
  total: 0,
  settings: {},
  paymentMethod: "cash",
};

describe("shop wall time", () => {
  test("keeps Asia/Hebron when the host zone is not the shop", () => {
    expect(SHOP_TZ).toBe("Asia/Hebron");
    const utcHost = wallOnHost("UTC");
    const hebronHost = wallOnHost("Asia/Hebron");
    expect(utcHost).toEqual({ zone: "Asia/Hebron", dateTime: "2026-07-11 00:00:00" });
    expect(hebronHost).toEqual(utcHost);
  });

  test("a receipt prints the Hebron clock, not the stored UTC text", () => {
    const wall = formatShopWall("2026-07-10 21:00:00");
    expect(wall.dateTime).toBe("2026-07-11 00:00:00");
    const text = buildReceiptText(receiptOpts);
    expect(text).toContain("التاريخ: 2026-07-11");
    expect(text).toContain("الوقت: 00:00");
    expect(text).not.toContain("21:00");
  });

  test("shop-day bounds include midnight Hebron and exclude it from the previous day", () => {
    const day = shopDaySqlBounds("2026-07-11");
    const previous = shopDaySqlBounds("2026-07-10");
    const instant = "2026-07-10 21:00:00";
    expect(instant >= day.startSql && instant <= day.endSql).toBe(true);
    expect(instant >= previous.startSql && instant <= previous.endSql).toBe(false);
  });

  test("document day arithmetic stays on the calendar date", () => {
    expect(dayBefore("2026-01-01")).toBe("2025-12-31");
    expect(dayBefore("2026-03-01")).toBe("2026-02-28");
    const localMidnight = new Date(2026, 8, 25, 0, 0, 0);
    expect(parseStatementDate(localMidnight)).toBe("2026-09-25");
  });
});
