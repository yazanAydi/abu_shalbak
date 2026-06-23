# End-to-End Test Matrix — "أبو شلبك" POS

Automated coverage in `backend/tests/` (run: `cd backend && npm test`).

| Scenario | Description | Test file | Status |
|---|---|---|---|
| A | Profit from sale-time cost snapshot | `profitSnapshot.test.js` | ✅ |
| C | Cost change does not alter old profit; refund reverses snapshot COGS | `profitSnapshot.test.js` | ✅ |
| F | Concurrent sales from stock 1 → both succeed, final −1 | `concurrentStock.test.js` | ✅ |
| G | Checkout idempotency (sequential + concurrent dupes) | `checkoutIdempotency.test.js` | ✅ |
| H | Product deactivation hides from POS, blocks checkout | `productDeactivation.test.js` | ✅ |
| I | Dashboard reconciles with source tables; daily_reports unused | `reconciliation.test.js` | ✅ |
| J | Refund sync: admin decision, unread/ack, ownership, single apply | `refundSync.test.js` | ✅ |

## Regression baseline (21 suites, 86 tests)

| Area | File |
|---|---|
| Auth | `auth.test.js`, `authorization.test.js` |
| Checkout | `checkout.test.js` |
| Inventory | `inventory.test.js` |
| Refunds | `refunds.test.js`, `refundRequests.test.js` |
| Shifts | `shiftSales.test.js` |
| SQL safety | `sqlInjection.test.js` |
| Import hardening | `importHardening.test.js` |
| Money precision | `moneyPrecision.test.js` |
| Sales by price | `salesByPrice.test.js` |
| Telegram | `telegramUpdate.test.js` |

## Manual acceptance (required before go-live)

See `STORE_ACCEPTANCE_TEST.md` — barcode scanner, receipt printer, multi-terminal LAN, backup/restore, shift close with real cash count.
