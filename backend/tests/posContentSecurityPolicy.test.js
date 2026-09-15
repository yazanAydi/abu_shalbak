import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import request from "supertest";
import { createApp } from "../app.js";
import { createTestContext, destroyTestContext } from "./helpers.js";
import {
  POS_PRINT_HELPER_ORIGIN,
  cspAllowsConnect,
  cspHeaderList,
  htmlHasCspMeta,
  parseCspDirectives,
  withPosPrintHelperConnectSrc,
} from "../utils/posContentSecurityPolicy.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const POS_INDEX_SRC = path.join(ROOT, "frontend-pos", "public", "index.html");
const HELPER_CLIENT = path.join(ROOT, "frontend-pos", "src", "utils", "windowsReceiptPrint.js");

const SHOP_ORIGIN = "http://100.100.100.13:3000";
const POS_DOCUMENT = `${SHOP_ORIGIN}/pos/`;
const HELPER_HEALTH = `${POS_PRINT_HELPER_ORIGIN}/health`;
const HELPER_PRINT = `${POS_PRINT_HELPER_ORIGIN}/print`;
const API_CHECKOUT = `${SHOP_ORIGIN}/api/v1/checkout`;
const API_EVENTS = `${SHOP_ORIGIN}/api/v1/pos/events`;

const POS_HTML =
  "<!doctype html><html lang=\"ar\"><head><meta charset=\"utf-8\"><title>POS</title></head><body><div id=\"root\">pos</div></body></html>";
const ADMIN_HTML =
  "<!doctype html><html><head><meta charset=\"utf-8\"><title>Admin</title></head><body>admin</body></html>";

const HELMET_LIKE =
  "default-src 'self';base-uri 'self';font-src 'self' https: data:;form-action 'self';frame-ancestors 'self';img-src 'self' data:;object-src 'none';script-src 'self';script-src-attr 'none';style-src 'self' https: 'unsafe-inline'";

describe("POS print helper CSP", () => {
  test("default-src 'self' alone blocks the helper; connect-src allows health and print", () => {
    expect(cspAllowsConnect(HELMET_LIKE, POS_DOCUMENT, HELPER_HEALTH)).toBe(false);
    expect(cspAllowsConnect(HELMET_LIKE, POS_DOCUMENT, HELPER_PRINT)).toBe(false);
    expect(cspAllowsConnect(HELMET_LIKE, POS_DOCUMENT, API_CHECKOUT)).toBe(true);

    const patched = withPosPrintHelperConnectSrc(HELMET_LIKE);
    const connect = parseCspDirectives(patched).get("connect-src");
    expect(connect).toEqual(["'self'", POS_PRINT_HELPER_ORIGIN]);
    expect(connect.join(" ")).not.toMatch(/\*/);
    expect(cspAllowsConnect(patched, POS_DOCUMENT, HELPER_HEALTH)).toBe(true);
    expect(cspAllowsConnect(patched, POS_DOCUMENT, HELPER_PRINT)).toBe(true);
    expect(cspAllowsConnect(patched, POS_DOCUMENT, API_CHECKOUT)).toBe(true);
    expect(cspAllowsConnect(patched, POS_DOCUMENT, API_EVENTS)).toBe(true);
    expect(cspAllowsConnect(patched, POS_DOCUMENT, "https://evil.example/print")).toBe(false);
    expect(cspAllowsConnect(patched, POS_DOCUMENT, "http://127.0.0.1:9/health")).toBe(false);
    expect(patched).toContain("object-src 'none'");
    expect(patched).toContain("default-src 'self'");
    expect(patched).not.toMatch(/upgrade-insecure-requests/i);
  });

  test("POS HTML source and helper client do not introduce a second policy or a different helper origin", () => {
    const html = fs.readFileSync(POS_INDEX_SRC, "utf8");
    expect(htmlHasCspMeta(html)).toBe(false);
    const client = fs.readFileSync(HELPER_CLIENT, "utf8");
    expect(client).toContain(`RECEIPT_PRINT_HELPER_URL = "${POS_PRINT_HELPER_ORIGIN}"`);
  });
});

describe("production-served /pos document CSP", () => {
  let ctx;
  let app;
  let posDist;
  let adminDist;
  const prevPos = process.env.POS_DIST;
  const prevAdmin = process.env.ADMIN_DIST;

  beforeAll(async () => {
    ctx = await createTestContext();
    posDist = fs.mkdtempSync(path.join(os.tmpdir(), "abo-pos-dist-"));
    adminDist = fs.mkdtempSync(path.join(os.tmpdir(), "abo-admin-dist-"));
    fs.writeFileSync(path.join(posDist, "index.html"), POS_HTML);
    fs.writeFileSync(path.join(adminDist, "index.html"), ADMIN_HTML);
    process.env.POS_DIST = posDist;
    process.env.ADMIN_DIST = adminDist;
    app = createApp(ctx.db, ctx.dbPath, { enableStatic: true });
  });

  afterAll(async () => {
    if (prevPos == null) delete process.env.POS_DIST;
    else process.env.POS_DIST = prevPos;
    if (prevAdmin == null) delete process.env.ADMIN_DIST;
    else process.env.ADMIN_DIST = prevAdmin;
    try {
      fs.rmSync(posDist, { recursive: true, force: true });
      fs.rmSync(adminDist, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    await destroyTestContext(ctx);
  });

  function assertPosDocumentPolicy(res) {
    expect(res.status).toBe(200);
    expect(String(res.headers["content-type"] || "")).toMatch(/html/i);
    expect(res.headers["content-security-policy-report-only"]).toBeUndefined();
    const policies = cspHeaderList(res);
    expect(policies.length).toBe(1);
    const csp = policies[0];
    expect(htmlHasCspMeta(res.text)).toBe(false);
    expect(csp.match(/connect-src/gi) || []).toHaveLength(1);
    expect(csp).not.toMatch(/upgrade-insecure-requests/i);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("script-src 'self'");
    expect(cspAllowsConnect(csp, POS_DOCUMENT, HELPER_HEALTH)).toBe(true);
    expect(cspAllowsConnect(csp, POS_DOCUMENT, HELPER_PRINT)).toBe(true);
    expect(cspAllowsConnect(csp, POS_DOCUMENT, API_CHECKOUT)).toBe(true);
    expect(cspAllowsConnect(csp, POS_DOCUMENT, API_EVENTS)).toBe(true);
    expect(cspAllowsConnect(csp, POS_DOCUMENT, "https://evil.example/x")).toBe(false);
  }

  async function loadPosDocument(url) {
    const first = await request(app).get(url).redirects(0).set("Host", "100.100.100.13:3000");
    if (first.status !== 301 && first.status !== 302) return first;
    const loc = String(first.headers.location || "");
    const nextPath = loc.startsWith("http") ? new URL(loc).pathname : loc;
    expect(nextPath === "/pos" || nextPath.startsWith("/pos/")).toBe(true);
    return request(app).get(nextPath).set("Host", "100.100.100.13:3000");
  }

  test("GET /pos and GET /pos/ allow helper /health and /print plus same-origin API", async () => {
    assertPosDocumentPolicy(await loadPosDocument("/pos/"));
    assertPosDocumentPolicy(await loadPosDocument("/pos"));
    assertPosDocumentPolicy(await loadPosDocument("/pos/login"));
  });

  test("office /admin keeps default-src 'self' and does not list the print helper", async () => {
    const res = await request(app).get("/admin/").set("Host", "100.100.100.13:3000");
    expect(res.status).toBe(200);
    const policies = cspHeaderList(res);
    expect(policies.length).toBe(1);
    const csp = policies[0];
    expect(csp).not.toMatch(/connect-src/i);
    expect(cspAllowsConnect(csp, `${SHOP_ORIGIN}/admin/`, HELPER_HEALTH)).toBe(false);
    expect(cspAllowsConnect(csp, `${SHOP_ORIGIN}/admin/`, `${SHOP_ORIGIN}/api/v1/health`)).toBe(true);
  });
});
