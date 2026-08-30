import request from "supertest";
import { getActivePromotions, invalidatePromotionsCache } from "../utils/promotions.js";
import { CACHE_KEYS, cacheGet } from "../utils/cache.js";
import { withTransaction } from "../utils/dbTx.js";
import {
  createTestContext,
  destroyTestContext,
  login,
  authHeader,
} from "./helpers.js";

function namesOf(promos) {
  return (promos || []).map((p) => p.name);
}

describe("promotions cache invalidation", () => {
  let ctx;
  let adminToken;
  let cashierToken;
  let unitId;

  beforeAll(async () => {
    ctx = await createTestContext();
    const adminLogin = await login(ctx.app, "testadmin", "adminpass123", "office");
    adminToken = adminLogin.body.token;
    const cashierLogin = await login(ctx.app, "testcashier", "cashpass123", "pos");
    cashierToken = cashierLogin.body.token;
    const unit = await ctx.db.get(
      "SELECT id FROM product_units WHERE product_id = ? LIMIT 1",
      [ctx.productId]
    );
    unitId = unit.id;
    invalidatePromotionsCache();
  });

  afterAll(async () => {
    await destroyTestContext(ctx);
  });

  async function createPromo(body) {
    return request(ctx.app)
      .post("/api/marketing/promotions")
      .set(authHeader(adminToken))
      .send(body);
  }

  test("create/update/delete are visible to getActivePromotions without waiting", async () => {
    await getActivePromotions(ctx.db);

    const created = await createPromo({
      name: "Cache create",
      offer_type: "percentage",
      category: "Test",
      discount_value: 10,
    });
    expect(created.status).toBe(201);
    const promoId = created.body.id;

    const afterCreate = await getActivePromotions(ctx.db);
    expect(namesOf(afterCreate)).toContain("Cache create");

    const updated = await request(ctx.app)
      .put(`/api/marketing/promotions/${promoId}`)
      .set(authHeader(adminToken))
      .send({
        name: "Cache updated",
        offer_type: "percentage",
        category: "Test",
        discount_value: 15,
        active: true,
      });
    expect(updated.status).toBe(200);

    const afterUpdate = await getActivePromotions(ctx.db);
    expect(namesOf(afterUpdate)).toContain("Cache updated");
    expect(namesOf(afterUpdate)).not.toContain("Cache create");

    const deactivated = await request(ctx.app)
      .put(`/api/marketing/promotions/${promoId}`)
      .set(authHeader(adminToken))
      .send({
        name: "Cache updated",
        offer_type: "percentage",
        category: "Test",
        discount_value: 15,
        active: false,
      });
    expect(deactivated.status).toBe(200);
    expect(namesOf(await getActivePromotions(ctx.db))).not.toContain("Cache updated");

    await request(ctx.app)
      .put(`/api/marketing/promotions/${promoId}`)
      .set(authHeader(adminToken))
      .send({
        name: "Cache updated",
        offer_type: "percentage",
        category: "Test",
        discount_value: 15,
        active: true,
      });
    expect(namesOf(await getActivePromotions(ctx.db))).toContain("Cache updated");

    const deleted = await request(ctx.app)
      .delete(`/api/marketing/promotions/${promoId}`)
      .set(authHeader(adminToken));
    expect(deleted.status).toBe(200);
    expect(namesOf(await getActivePromotions(ctx.db))).not.toContain("Cache updated");
  });

  test("checkout quote and /active reflect a new promo immediately", async () => {
    await getActivePromotions(ctx.db);

    const created = await createPromo({
      name: "Quote now",
      offer_type: "percentage",
      product_id: ctx.productId,
      product_unit_id: unitId,
      discount_value: 50,
    });
    expect(created.status).toBe(201);

    const active = await request(ctx.app)
      .get("/api/marketing/active")
      .set(authHeader(cashierToken));
    expect(active.status).toBe(200);
    expect(namesOf(active.body)).toContain("Quote now");

    const quote = await request(ctx.app)
      .post("/api/marketing/quote")
      .set(authHeader(cashierToken))
      .send({
        items: [{ product_id: ctx.productId, product_unit_id: unitId, quantity: 2 }],
      });
    expect(quote.status).toBe(200);
    expect(quote.body.discount).toBe(10);

    await request(ctx.app)
      .delete(`/api/marketing/promotions/${created.body.id}`)
      .set(authHeader(adminToken));
  });

  test("campaign deactivate drops linked promos from the active cache immediately", async () => {
    const campaign = await request(ctx.app)
      .post("/api/marketing/campaigns")
      .set(authHeader(adminToken))
      .send({ name: "Cache campaign", active: true });
    expect(campaign.status).toBe(201);

    const created = await createPromo({
      name: "Campaign-linked",
      offer_type: "percentage",
      category: "Test",
      discount_value: 5,
      campaign_id: campaign.body.id,
    });
    expect(created.status).toBe(201);
    expect(namesOf(await getActivePromotions(ctx.db))).toContain("Campaign-linked");

    const paused = await request(ctx.app)
      .put(`/api/marketing/campaigns/${campaign.body.id}`)
      .set(authHeader(adminToken))
      .send({ active: false });
    expect(paused.status).toBe(200);
    expect(namesOf(await getActivePromotions(ctx.db))).not.toContain("Campaign-linked");

    await request(ctx.app)
      .delete(`/api/marketing/promotions/${created.body.id}`)
      .set(authHeader(adminToken));
    await request(ctx.app)
      .delete(`/api/marketing/campaigns/${campaign.body.id}`)
      .set(authHeader(adminToken));
  });

  test("failed validation does not clear a still-valid promotions cache", async () => {
    invalidatePromotionsCache();
    await getActivePromotions(ctx.db);
    expect(cacheGet(CACHE_KEYS.PROMOTIONS)).toBeTruthy();

    const failed = await createPromo({
      offer_type: "percentage",
      category: "Test",
      discount_value: 10,
    });
    expect(failed.status).toBe(400);
    expect(cacheGet(CACHE_KEYS.PROMOTIONS)).toBeTruthy();
  });

  test("rolled-back SQL does not publish a promo through the cache", async () => {
    invalidatePromotionsCache();
    const before = await getActivePromotions(ctx.db);
    expect(namesOf(before)).not.toContain("Rolled back promo");

    await expect(
      withTransaction(ctx.db, async () => {
        await ctx.db.run(
          `INSERT INTO promotions
             (name, offer_type, category, discount_value, active)
           VALUES ('Rolled back promo', 'percentage', 'Test', 10, 1)`
        );
        throw new Error("force rollback");
      })
    ).rejects.toThrow("force rollback");

    const after = await getActivePromotions(ctx.db);
    expect(namesOf(after)).not.toContain("Rolled back promo");
    const row = await ctx.db.get("SELECT id FROM promotions WHERE name = 'Rolled back promo'");
    expect(row).toBeUndefined();
  });

  test("renaming a category used by promotions invalidates the cache", async () => {
    const cat = await request(ctx.app)
      .post("/api/v1/products/categories")
      .set(authHeader(adminToken))
      .send({ name: "CacheCat" });
    expect(cat.status).toBe(201);
    const catId = (cat.body.data ?? cat.body).id;

    const created = await createPromo({
      name: "Category promo",
      offer_type: "percentage",
      category: "CacheCat",
      discount_value: 10,
    });
    expect(created.status).toBe(201);
    expect((await getActivePromotions(ctx.db)).some((p) => p.category === "CacheCat")).toBe(true);

    const renamed = await request(ctx.app)
      .put(`/api/v1/products/categories/${catId}`)
      .set(authHeader(adminToken))
      .send({ name: "CacheCatRenamed" });
    expect(renamed.status).toBe(200);

    const after = await getActivePromotions(ctx.db);
    expect(after.some((p) => p.category === "CacheCatRenamed")).toBe(true);
    expect(after.some((p) => p.category === "CacheCat")).toBe(false);

    await request(ctx.app)
      .delete(`/api/marketing/promotions/${created.body.id}`)
      .set(authHeader(adminToken));
  });
});
