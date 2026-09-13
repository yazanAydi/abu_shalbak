import fs from "fs";
import os from "os";
import path from "path";
import request from "supertest";
import {
  closeSqliteConnection,
  openSqliteConnection,
  useBetterSqlite,
} from "../database/sqliteDriver.js";
import { createBackup } from "../utils/backup.js";
import {
  authHeader,
  createTestContext,
  destroyTestContext,
  login,
} from "./helpers.js";

const WAL_MARKER = "wal-committed-marker";
const prevBackupDir = process.env.BACKUP_DIR;

async function openWalScratch() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "abo-shalbak-backup-"));
  const dbPath = path.join(tmpDir, "src.db");
  const backupDir = path.join(tmpDir, "backups");
  fs.mkdirSync(backupDir);
  const writer = await openSqliteConnection(dbPath);
  await writer.exec(
    "CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT NOT NULL, price REAL NOT NULL)"
  );
  await writer.run("INSERT INTO products (name, price) VALUES (?, ?)", [WAL_MARKER, 12.5]);
  const journal = await writer.get("PRAGMA journal_mode");
  const walPath = `${dbPath}-wal`;
  return { tmpDir, dbPath, backupDir, writer, journal, walPath };
}

async function destroyWalScratch(scratch) {
  if (!scratch) return;
  try {
    await closeSqliteConnection(scratch.writer);
  } catch {
    /* ignore */
  }
  scratch.writer = null;
  try {
    fs.rmSync(scratch.tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

async function openIndependent(dbPath) {
  return openSqliteConnection(dbPath, { readonly: true, isolated: true });
}

describe("admin backup snapshot", () => {
  afterEach(() => {
    if (prevBackupDir === undefined) delete process.env.BACKUP_DIR;
    else process.env.BACKUP_DIR = prevBackupDir;
  });

  test("reports the machine driver and SQLite version", async () => {
    const better = await useBetterSqlite();
    const db = await openSqliteConnection(":memory:");
    try {
      const ver = await db.get("SELECT sqlite_version() AS v");
      expect(db.driver).toBe(better ? "better-sqlite3" : "sqlite3");
      expect(String(ver.v)).toMatch(/^\d+\.\d+/);
      expect(await db.get("PRAGMA query_only")).toEqual({ query_only: 0 });
    } finally {
      await closeSqliteConnection(db);
    }
  });

  test("VACUUM INTO keeps committed WAL rows; verify opens a DELETE snapshot readonly", async () => {
    const scratch = await openWalScratch();
    process.env.BACKUP_DIR = scratch.backupDir;
    try {
      expect(String(scratch.journal.journal_mode).toLowerCase()).toBe("wal");
      expect(fs.existsSync(scratch.walPath)).toBe(true);
      expect(fs.statSync(scratch.walPath).size).toBeGreaterThan(0);

      const sourceBefore = await scratch.writer.get(
        "SELECT COUNT(*) AS n, name, price FROM products"
      );
      expect(sourceBefore.n).toBe(1);
      expect(sourceBefore.name).toBe(WAL_MARKER);

      const result = await createBackup(scratch.dbPath);
      expect(result.filename).toMatch(/^supermarket_\d{4}-\d{2}-\d{2}_\d{6}\.db$/);
      expect(fs.existsSync(result.path)).toBe(true);
      expect(result.size).toBeGreaterThan(0);

      const sourceAfter = await scratch.writer.get(
        "SELECT COUNT(*) AS n, name, price FROM products"
      );
      expect(sourceAfter).toEqual(sourceBefore);
      expect(fs.existsSync(scratch.walPath)).toBe(true);

      const peek = await openIndependent(result.path);
      try {
        const destJournal = await peek.get("PRAGMA journal_mode");
        expect(String(destJournal.journal_mode).toLowerCase()).toBe("delete");
        const integrity = await peek.get("PRAGMA integrity_check");
        expect(integrity.integrity_check).toBe("ok");
        const row = await peek.get("SELECT name, price FROM products");
        expect(row.name).toBe(WAL_MARKER);
        expect(Number(row.price)).toBe(12.5);
      } finally {
        await closeSqliteConnection(peek);
      }
    } finally {
      await destroyWalScratch(scratch);
    }
  });

  test("POST /api/v1/admin/backup returns 201 and a usable snapshot", async () => {
    const ctx = await createTestContext();
    const backupDir = path.join(ctx.tmpDir, "office-backups");
    fs.mkdirSync(backupDir);
    process.env.BACKUP_DIR = backupDir;
    try {
      const walPath = `${ctx.dbPath}-wal`;
      expect(fs.existsSync(walPath)).toBe(true);
      expect(fs.statSync(walPath).size).toBeGreaterThan(0);

      await ctx.db.run("UPDATE products SET name = ? WHERE barcode = '9990001'", [
        WAL_MARKER,
      ]);
      const productBefore = await ctx.db.get(
        "SELECT id, name, price, stock FROM products WHERE barcode = '9990001'"
      );
      const userCountBefore = await ctx.db.get("SELECT COUNT(*) AS n FROM users");

      const token = (await login(ctx.app, "testadmin", "adminpass123", "office")).body.token;
      const res = await request(ctx.app)
        .post("/api/v1/admin/backup")
        .set(authHeader(token));

      expect(res.status).toBe(201);
      const payload = res.body.data ?? res.body;
      expect(payload.filename).toMatch(/^supermarket_\d{4}-\d{2}-\d{2}_\d{6}\.db$/);
      expect(payload.size).toBeGreaterThan(0);

      const dest = path.join(backupDir, payload.filename);
      expect(fs.existsSync(dest)).toBe(true);

      const productAfter = await ctx.db.get(
        "SELECT id, name, price, stock FROM products WHERE barcode = '9990001'"
      );
      expect(productAfter).toEqual(productBefore);
      const userCountAfter = await ctx.db.get("SELECT COUNT(*) AS n FROM users");
      expect(userCountAfter.n).toBe(userCountBefore.n);

      const snap = await openIndependent(dest);
      try {
        const integrity = await snap.get("PRAGMA integrity_check");
        expect(integrity.integrity_check).toBe("ok");
        const product = await snap.get(
          "SELECT name, price, stock FROM products WHERE barcode = '9990001'"
        );
        expect(product.name).toBe(WAL_MARKER);
        expect(Number(product.price)).toBe(10);
        expect(Number(product.stock)).toBe(100);
        const users = await snap.get("SELECT COUNT(*) AS n FROM users");
        expect(users.n).toBe(userCountBefore.n);
      } finally {
        await closeSqliteConnection(snap);
      }
    } finally {
      await destroyTestContext(ctx);
    }
  });

  test("failed backup closes its source connection and leaves business rows untouched", async () => {
    const scratch = await openWalScratch();
    const notADir = path.join(scratch.tmpDir, "not-a-dir");
    fs.writeFileSync(notADir, "x");
    process.env.BACKUP_DIR = notADir;
    try {
      await expect(createBackup(scratch.dbPath)).rejects.toThrow();
      const stillThere = await scratch.writer.get("SELECT name FROM products");
      expect(stillThere.name).toBe(WAL_MARKER);
      await closeSqliteConnection(scratch.writer);
      scratch.writer = null;
      expect(() => fs.unlinkSync(scratch.dbPath)).not.toThrow();
    } finally {
      await destroyWalScratch(scratch);
    }
  });
});
