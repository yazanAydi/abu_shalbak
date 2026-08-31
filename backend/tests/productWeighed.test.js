import request from "supertest";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";
import { findKgUnit, isWeighedBaseUnit } from "../utils/productUnits.js";

describe("product is_weighed (scale product)", () => {
  let ctx;
  let adminToken;

  beforeAll(async () => {
    ctx = await createTestContext();
    adminToken = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  function unwrap(res) {
    return res.body?.data ?? res.body;
  }

  test("create without is_weighed stores 0", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "6281111111111",
        name: "منتج عادي",
        price: 4,
        stock: 10,
        unit: "حبة",
      });
    expect(res.status).toBe(201);
    const row = unwrap(res);
    expect(Number(row.is_weighed)).toBe(0);
    expect(row.barcode).toBe("6281111111111");
  });

  test("create with is_weighed true keeps a normal barcode and sets unit to كغم", async () => {
    const barcode = "6281234567890";
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "خيار",
        price: 6,
        stock: 20,
        is_weighed: true,
      });
    expect(res.status).toBe(201);
    const row = unwrap(res);
    expect(Number(row.is_weighed)).toBe(1);
    expect(row.barcode).toBe(barcode);
    expect(row.unit).toBe("كغم");

    const listed = await request(ctx.app)
      .get("/api/v1/products")
      .query({ ids: String(row.id) })
      .set(authHeader(adminToken));
    expect(listed.status).toBe(200);
    const items = unwrap(listed);
    const listRow = Array.isArray(items) ? items[0] : items;
    expect(Number(listRow.is_weighed)).toBe(1);
    expect(listRow.barcode).toBe(barcode);

    const dash = await request(ctx.app)
      .get(`/api/v1/products/${row.id}/dashboard`)
      .set(authHeader(adminToken));
    expect(dash.status).toBe(200);
    expect(Number(unwrap(dash).product.is_weighed)).toBe(1);
    expect(unwrap(dash).product.barcode).toBe(barcode);

    const overview = await request(ctx.app)
      .get(`/api/v1/products/${row.id}/overview`)
      .set(authHeader(adminToken));
    expect(overview.status).toBe(200);
    expect(Number(unwrap(overview).basic.is_weighed)).toBe(1);

    const lookup = await request(ctx.app)
      .get("/api/v1/products/lookup")
      .query({ barcode })
      .set(authHeader(adminToken));
    expect(lookup.status).toBe(200);
    const lookupBody = unwrap(lookup);
    expect(lookupBody.found).toBe(true);
    expect(lookupBody.product.is_weighed).toBe(true);
    expect(lookupBody.product.barcode).toBe(barcode);
  });

  test("create with scale_code and package_conversion keeps package barcode and dual units", async () => {
    const barcode = "6251234567890";
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "مرتديلا شركة A",
        price: 25,
        stock: 0,
        is_weighed: true,
        scale_code: "2100003",
        package_conversion: 2,
        package_price: 12,
      });
    expect(res.status).toBe(201);
    const row = unwrap(res);
    expect(Number(row.is_weighed)).toBe(1);
    expect(row.barcode).toBe(barcode);
    expect(row.scale_code).toBe("2100003");
    expect(row.unit).toBe("كغم");
    expect(Number(row.price)).toBe(25);
    expect(Number(row.package_price)).toBe(12);
    expect(Number(row.package_conversion)).toBe(2);

    const unitsRes = await request(ctx.app)
      .get(`/api/v1/products/${row.id}/units`)
      .set(authHeader(adminToken));
    expect(unitsRes.status).toBe(200);
    const units = unwrap(unitsRes).units;
    const kg = units.find((u) => u.unit_name === "كغم");
    const pack = units.find((u) => u.unit_name === "حبة");
    expect(kg).toBeTruthy();
    expect(kg.barcode).toBe("2100003");
    expect(Number(kg.conversion_to_base)).toBe(1);
    expect(Number(kg.price)).toBe(25);
    expect(kg.is_default).toBe(true);
    expect(pack).toBeTruthy();
    expect(pack.barcode).toBe(barcode);
    expect(Number(pack.conversion_to_base)).toBe(2);
    expect(Number(pack.price)).toBe(12);
    expect(Number(pack.price)).not.toBe(Number(kg.price) * Number(pack.conversion_to_base));
    expect(pack.is_default_purchase).toBe(true);
  });

  test("PUT toggles is_weighed on and off without changing barcode", async () => {
    const barcode = "6281999888777";
    const created = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "بندورة",
        price: 5,
        stock: 8,
        unit: "حبة",
      });
    expect(created.status).toBe(201);
    const id = unwrap(created).id;

    const on = await request(ctx.app)
      .put(`/api/v1/products/${id}`)
      .set(authHeader(adminToken))
      .send({ is_weighed: 1 });
    expect(on.status).toBe(200);
    expect(Number(unwrap(on).is_weighed)).toBe(1);
    expect(unwrap(on).barcode).toBe(barcode);
    expect(unwrap(on).unit).toBe("كغم");

    const off = await request(ctx.app)
      .put(`/api/v1/products/${id}`)
      .set(authHeader(adminToken))
      .send({ is_weighed: 0 });
    expect(off.status).toBe(200);
    expect(Number(unwrap(off).is_weighed)).toBe(0);
    expect(unwrap(off).barcode).toBe(barcode);
  });

  test("duplicate barcode is still rejected when the new product is weighed", async () => {
    const barcode = "6281555666777";
    const first = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "أول منتج",
        price: 3,
        stock: 1,
      });
    expect(first.status).toBe(201);

    const dup = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode,
        name: "خيار ميزان",
        price: 6,
        stock: 1,
        is_weighed: true,
      });
    expect(dup.status).toBe(409);
  });

  test("omitting package_price does not derive it from KG price × conversion", async () => {
    const res = await request(ctx.app)
      .post("/api/v1/products")
      .set(authHeader(adminToken))
      .send({
        barcode: "6253333333333",
        name: "مرتديلا بدون سعر حبة",
        price: 25,
        stock: 0,
        is_weighed: true,
        scale_code: "2100066",
        package_conversion: 2,
      });
    expect(res.status).toBe(201);
    const row = unwrap(res);
    expect(Number(row.package_price)).toBe(0);
    const units = unwrap(
      await request(ctx.app)
        .get(`/api/v1/products/${row.id}/units`)
        .set(authHeader(adminToken))
    ).units;
    const pack = units.find((u) => u.unit_name === "حبة");
    expect(Number(pack.price)).toBe(0);
    expect(Number(pack.price)).not.toBe(50);
  });

  test("findKgUnit does not treat a 1 KG package as the deli unit", () => {
    const pack = { id: 1, unit_name: "حبة", conversion_to_base: 1, price: 12, is_default: false };
    const kg = { id: 2, unit_name: "كغم", conversion_to_base: 1, price: 6, is_default: true };
    expect(findKgUnit([pack, kg]).id).toBe(2);
    expect(findKgUnit([kg, pack]).id).toBe(2);
    expect(findKgUnit([pack])).toBeNull();
    expect(isWeighedBaseUnit(pack, true)).toBe(false);
    expect(isWeighedBaseUnit(kg, true)).toBe(true);
  });
});
