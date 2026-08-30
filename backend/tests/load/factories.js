/**
 * Deterministic fixtures for concurrency / load tests.
 * Passwords are hashed once and reused so seeding 50 cashiers stays cheap.
 */
import bcrypt from "bcrypt";
import { formatProductSku } from "../../utils/entityCodes.js";

export const LOAD_ADMIN = { username: "loadadmin", password: "loadadmin123", role: "admin" };
export const LOAD_CASHIER_PASSWORD = "loadcash123";
export const LOAD_OFFICE_PASSWORD = "loadoffice123";

export const SIZE_PRESETS = {
  small: { products: 30, customers: 10, suppliers: 5, cashiers: 5, office: 2, promotions: 2, batches: 8 },
  medium: { products: 200, customers: 40, suppliers: 15, cashiers: 20, office: 4, promotions: 4, batches: 20 },
  large: { products: 2000, customers: 100, suppliers: 40, cashiers: 50, office: 6, promotions: 8, batches: 40 },
};

let cachedHashes = null;

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function next() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function hashes() {
  if (cachedHashes) return cachedHashes;
  cachedHashes = {
    admin: await bcrypt.hash(LOAD_ADMIN.password, 4),
    cashier: await bcrypt.hash(LOAD_CASHIER_PASSWORD, 4),
    office: await bcrypt.hash(LOAD_OFFICE_PASSWORD, 4),
  };
  return cachedHashes;
}

export function productBarcode(n) {
  return `88${String(n).padStart(11, "0")}`.slice(0, 13);
}

export function productSku(n) {
  return formatProductSku(800000 + n);
}

export async function insertCashier(db, { username, index = 0 } = {}) {
  const h = await hashes();
  const name = username || `loadcashier${String(index + 1).padStart(2, "0")}`;
  const ins = await db.run(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'cashier', 0)",
    [name, h.cashier]
  );
  return { id: ins.lastID, username: name, password: LOAD_CASHIER_PASSWORD, role: "cashier" };
}

export async function insertAdmin(db, { username } = {}) {
  const h = await hashes();
  const name = username || LOAD_ADMIN.username;
  const existing = await db.get("SELECT id FROM users WHERE username = ?", [name]);
  if (existing) {
    await db.run("UPDATE users SET password = ?, must_change_password = 0, role = 'admin' WHERE id = ?", [
      h.admin,
      existing.id,
    ]);
    return { id: existing.id, username: name, password: LOAD_ADMIN.password, role: "admin" };
  }
  const ins = await db.run(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'admin', 0)",
    [name, h.admin]
  );
  return { id: ins.lastID, username: name, password: LOAD_ADMIN.password, role: "admin" };
}

export async function insertOfficeUser(db, { username, index = 0 } = {}) {
  const h = await hashes();
  const name = username || `loadoffice${String(index + 1).padStart(2, "0")}`;
  const ins = await db.run(
    "INSERT INTO users (username, password, role, must_change_password) VALUES (?, ?, 'accountant', 0)",
    [name, h.office]
  );
  return { id: ins.lastID, username: name, password: LOAD_OFFICE_PASSWORD, role: "accountant" };
}

export async function insertProduct(db, fields = {}) {
  const n = fields.n ?? Date.now() % 1e8;
  const barcode = fields.barcode || productBarcode(n);
  const name = fields.name || `Load Product ${n}`;
  const price = fields.price != null ? Number(fields.price) : 10;
  const cost = fields.cost != null ? Number(fields.cost) : 5;
  const stock = fields.stock != null ? Number(fields.stock) : 100;
  const category = fields.category || "LoadTest";
  const sku = fields.sku || productSku(n);
  const minStock = fields.min_stock != null ? Number(fields.min_stock) : null;
  const ins = await db.run(
    `INSERT INTO products (barcode, name, price, cost, category, stock, sku, min_stock, is_active, inventory_scope)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 'retail')`,
    [barcode, name, price, cost, category, stock, sku, minStock]
  );
  const id = ins.lastID;
  await db.run(`INSERT INTO product_barcodes (product_id, barcode, is_primary) VALUES (?, ?, 1)`, [id, barcode]);
  await db.run(
    `INSERT INTO product_units (product_id, unit_name, barcode, price, cost, conversion_to_base, is_default)
     VALUES (?, 'حبة', ?, ?, ?, 1, 1)`,
    [id, barcode, price, cost]
  );
  return { id, barcode, name, price, cost, stock, sku, category };
}

export async function insertCustomer(db, fields = {}) {
  const name = fields.name || `Load Customer ${fields.n ?? 1}`;
  const creditLimit = fields.credit_limit != null ? Number(fields.credit_limit) : 0;
  const opening = fields.opening_balance != null ? Number(fields.opening_balance) : 0;
  const balance = fields.balance != null ? Number(fields.balance) : opening;
  const ins = await db.run(
    `INSERT INTO customers (name, phone, credit_limit, opening_balance, balance, no_credit)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [name, fields.phone || null, creditLimit, opening, balance, fields.no_credit ? 1 : 0]
  );
  return { id: ins.lastID, name, credit_limit: creditLimit, opening_balance: opening, balance };
}

export async function insertSupplier(db, fields = {}) {
  const name = fields.name || `Load Supplier ${fields.n ?? 1}`;
  const opening = fields.opening_balance != null ? Number(fields.opening_balance) : 0;
  const ins = await db.run(
    `INSERT INTO suppliers (name, contact_phone, opening_balance, balance) VALUES (?, ?, ?, ?)`,
    [name, fields.phone || null, opening, opening]
  );
  return { id: ins.lastID, name, opening_balance: opening, balance: opening };
}

export async function insertPromotion(db, fields = {}) {
  const ins = await db.run(
    `INSERT INTO promotions
       (name, offer_type, product_id, discount_value, buy_qty, get_qty, min_amount,
        limit_qty, used_qty, stop_when_out_of_stock, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
    [
      fields.name || "Load Promo",
      fields.offer_type || "percentage",
      fields.product_id,
      fields.discount_value ?? 10,
      fields.buy_qty ?? 0,
      fields.get_qty ?? 0,
      fields.min_amount ?? 0,
      fields.limit_qty ?? 0,
      fields.used_qty ?? 0,
      fields.stop_when_out_of_stock ? 1 : 0,
    ]
  );
  return { id: ins.lastID, ...fields };
}

export async function insertExpiryBatch(db, { productId, daysFromNow = 3, quantity = 5, n = 1 } = {}) {
  const d = new Date();
  d.setDate(d.getDate() + daysFromNow);
  const expiry = d.toISOString().slice(0, 10);
  const ins = await db.run(
    `INSERT INTO product_batches (product_id, batch_no, expiry_date, quantity, cost)
     VALUES (?, ?, ?, ?, 5)`,
    [productId, `B${n}`, expiry, quantity]
  );
  return { id: ins.lastID, product_id: productId, expiry_date: expiry, quantity };
}

export function buildProductCsv(rows) {
  const header = "barcode,name,price,cost,category";
  const body = rows
    .map((r) => `${r.barcode},${r.name},${r.price ?? 5},${r.cost ?? 2},${r.category || "Imported"}`)
    .join("\n");
  return `${header}\n${body}\n`;
}

export function importedProductRows(count, start = 900000) {
  return Array.from({ length: count }, (_, i) => {
    const n = start + i;
    return {
      barcode: productBarcode(n),
      name: `Import Row ${n}`,
      price: 5,
      cost: 2,
      category: "Imported",
    };
  });
}

/**
 * Seed a realistic workload onto an already-initialized database.
 */
export async function seedWorkloadFixtures(db, size = "small", opts = {}) {
  const preset = SIZE_PRESETS[size] || SIZE_PRESETS.small;
  const rng = mulberry32(opts.seed ?? 20260830);
  const admin = await insertAdmin(db);

  const cashiers = [];
  for (let i = 0; i < preset.cashiers; i += 1) {
    cashiers.push(await insertCashier(db, { index: i }));
  }
  const office = [];
  for (let i = 0; i < preset.office; i += 1) {
    office.push(await insertOfficeUser(db, { index: i }));
  }

  const products = [];
  for (let i = 0; i < preset.products; i += 1) {
    const price = Math.round((4 + rng() * 20) * 100) / 100;
    products.push(
      await insertProduct(db, {
        n: 1000 + i,
        name: `صنف أداء ${String(i + 1).padStart(4, "0")}`,
        price,
        cost: Math.round(price * 0.55 * 100) / 100,
        stock: 50 + Math.floor(rng() * 200),
        category: `تصنيف ${String((i % 12) + 1).padStart(3, "0")}`,
      })
    );
  }

  const customers = [];
  for (let i = 0; i < preset.customers; i += 1) {
    const opening = i === 0 ? 900 : Math.round(rng() * 200);
    customers.push(
      await insertCustomer(db, {
        n: i + 1,
        name: `زبون ${i + 1}`,
        credit_limit: i === 0 ? 1000 : i % 3 === 0 ? 500 : 0,
        opening_balance: opening,
        balance: opening,
        phone: `059${String(1000000 + i).slice(0, 7)}`,
      })
    );
  }

  const suppliers = [];
  for (let i = 0; i < preset.suppliers; i += 1) {
    suppliers.push(
      await insertSupplier(db, { n: i + 1, name: `مورد ${i + 1}`, opening_balance: Math.round(rng() * 100) })
    );
  }

  const promotions = [];
  for (let i = 0; i < preset.promotions && products[i]; i += 1) {
    promotions.push(
      await insertPromotion(db, {
        name: `عرض محدود ${i + 1}`,
        offer_type: "percentage",
        product_id: products[i].id,
        discount_value: 10,
        limit_qty: 10,
        used_qty: 0,
      })
    );
  }

  const batches = [];
  for (let i = 0; i < preset.batches && products[i]; i += 1) {
    batches.push(
      await insertExpiryBatch(db, { productId: products[i].id, daysFromNow: 2 + (i % 10), n: i + 1 })
    );
  }

  return { admin, cashiers, office, products, customers, suppliers, promotions, batches, size, preset };
}
