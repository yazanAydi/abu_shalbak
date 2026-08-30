# Query plans

Generated 2026-08-30T00:41:08.524Z against `perf.db`.

## product list page (CAST sku sort — legacy)

```sql
SELECT id, barcode, name, sku FROM products WHERE COALESCE(inventory_scope, 'retail') = 'retail' ORDER BY CAST(sku AS INTEGER) ASC, id ASC LIMIT 200 OFFSET 0
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 7 | 0 | 0 | SCAN products |
| 27 | 0 | 0 | USE TEMP B-TREE FOR ORDER BY |

## product list page (text sku sort — current)

```sql
SELECT id, barcode, name, sku FROM products WHERE COALESCE(inventory_scope, 'retail') = 'retail' ORDER BY sku ASC, id ASC LIMIT 200 OFFSET 0
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 8 | 0 | 0 | SCAN products USING INDEX idx_products_sku_sort |

## product count

```sql
SELECT COUNT(*) AS total FROM products WHERE COALESCE(inventory_scope, 'retail') = 'retail'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SCAN products USING COVERING INDEX idx_products_inventory_scope |

## sku CAST equality

```sql
SELECT id FROM products WHERE CAST(sku AS INTEGER) = 42
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SCAN products USING COVERING INDEX idx_products_sku_sort |

## sku padded equality

```sql
SELECT id FROM products WHERE sku = '00000000042'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH products USING COVERING INDEX idx_products_sku_sort (sku=?) |

## name LIKE search

```sql
SELECT id FROM products WHERE name LIKE '%أداء%' LIMIT 50
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SCAN products USING COVERING INDEX idx_products_name_nocase |

## barcode exact

```sql
SELECT id FROM products WHERE barcode = '2000000000001'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH products USING COVERING INDEX sqlite_autoindex_products_1 (barcode=?) |

## category filter

```sql
SELECT id FROM products WHERE category = 'تصنيف 001' LIMIT 50
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SEARCH products USING COVERING INDEX idx_products_category (category=?) |

## POS active retail filter

```sql
SELECT id FROM products WHERE COALESCE(is_active, 1) = 1 AND COALESCE(inventory_scope, 'retail') = 'retail' LIMIT 20
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SCAN products USING COVERING INDEX idx_products_active_scope |

## needs_review filter

```sql
SELECT id FROM products WHERE needs_review = 1 LIMIT 50
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SEARCH products USING COVERING INDEX idx_products_needs_review (needs_review=?) |

## transactions by created_at range

```sql
SELECT id, total FROM transactions WHERE created_at >= '2026-01-01' AND created_at < '2026-12-31'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SEARCH transactions USING INDEX idx_transactions_created_at (created_at>? AND created_at<?) |

## transactions date() wrapper

```sql
SELECT COALESCE(SUM(total),0) t FROM transactions WHERE date(created_at) >= '2026-01-01' AND date(created_at) <= '2026-12-31'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SCAN transactions |

## inventory ledger by product+type

```sql
SELECT id FROM inventory_ledger WHERE product_id = 1 AND movement_type = 'sale'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH inventory_ledger USING COVERING INDEX idx_inv_ledger_product_type (product_id=? AND movement_type=?) |

## purchase invoice items by product

```sql
SELECT id FROM purchase_invoice_items WHERE product_id = 1
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH purchase_invoice_items USING COVERING INDEX idx_pinvi_product (product_id=?) |

## transaction items by product+date

```sql
SELECT id FROM transaction_items WHERE product_id = 1 AND created_at >= '2026-01-01'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH transaction_items USING COVERING INDEX idx_tx_items_prod_created (product_id=? AND created_at>?) |

## product_barcodes exact

```sql
SELECT product_id FROM product_barcodes WHERE barcode = '2000000000001'
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SEARCH product_barcodes USING INDEX sqlite_autoindex_product_barcodes_1 (barcode=?) |

## product_units by product

```sql
SELECT id FROM product_units WHERE product_id = 1
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH product_units USING COVERING INDEX idx_product_units_product (product_id=?) |

## MAX(sku)

```sql
SELECT MAX(sku) AS mx FROM products WHERE sku IS NOT NULL AND TRIM(sku) != ''
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 3 | 0 | 0 | SEARCH products USING COVERING INDEX idx_products_sku_sort (sku>?) |

## all sku scan (legacy next-sku)

```sql
SELECT sku FROM products WHERE sku IS NOT NULL AND TRIM(sku) != ''
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SEARCH products USING COVERING INDEX idx_products_sku_sort (sku>?) |

## settings full scan

```sql
SELECT key, value FROM app_settings
```

| id | parent | notused | detail |
| --- | --- | --- | --- |
| 2 | 0 | 0 | SCAN app_settings |

