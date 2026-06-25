import { Router } from "express";
import { requireAuth, requireAdmin } from "../middleware/auth.js";
import { findProductByBarcode, normalizeBarcodeInput } from "../utils/barcode.js";
import { searchProducts } from "./products.js";

function debugEndpointEnabled() {
  if (process.env.DEBUG_BARCODE_ENDPOINT === "1") return true;
  return process.env.NODE_ENV !== "production";
}

export function createDebugRouter(db) {
  const router = Router();

  router.use(requireAuth, requireAdmin);

  router.get("/barcode/:barcode", async (req, res) => {
    if (!debugEndpointEnabled()) {
      return res.status(404).json({ error: "Not found" });
    }

    const searchedBarcode = normalizeBarcodeInput(decodeURIComponent(req.params.barcode));
    if (!searchedBarcode) {
      return res.status(400).json({ error: "باركود فارغ" });
    }

    const foundInProductsTable = await db.all(
      `SELECT * FROM products
       WHERE CAST(barcode AS TEXT) = ? OR barcode LIKE ?`,
      [searchedBarcode, `%${searchedBarcode}%`]
    );

    const foundInProductBarcodesTable = await db.all(
      `SELECT p.id, p.name, p.barcode, pb.barcode AS alias_barcode, pb.label, pb.is_primary
       FROM product_barcodes pb
       JOIN products p ON p.id = pb.product_id
       WHERE pb.barcode = ?`,
      [searchedBarcode]
    );

    const fromLookup = await findProductByBarcode(db, searchedBarcode);
    const fromSearchQuery = await searchProducts(db, searchedBarcode);

    res.json({
      searchedBarcode,
      foundInProductsTable,
      foundInProductBarcodesTable,
      finalProductResult: {
        fromLookup: fromLookup
          ? {
              id: fromLookup.product.id,
              name: fromLookup.product.name,
              barcode: fromLookup.product.barcode,
              matched_barcode: fromLookup.matchedBarcode,
              product_barcode_id: fromLookup.productBarcodeId,
            }
          : null,
        fromSearchQuery,
      },
    });
  });

  return router;
}
