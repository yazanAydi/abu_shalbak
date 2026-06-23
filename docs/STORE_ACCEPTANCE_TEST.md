# Store Acceptance Test — "أبو شلبك" POS

Use this checklist on the **actual store LAN** after deployment. Automated tests alone are not sufficient for go-live.

## Environment

- [ ] Server running with correct `[db] Using database file:` path in console
- [ ] At least one cashier PC and one office PC on same network
- [ ] Default passwords changed

## Sales (POS)

- [ ] Cashier opens shift with opening cash
- [ ] Barcode scan adds product to cart
- [ ] Quick-button product adds to cart
- [ ] Sale with item that goes negative stock: **warning shown, sale completes**
- [ ] Cash payment completes; receipt prints (or print preview OK)
- [ ] Visa payment completes
- [ ] Duplicate payment click / network retry: **only one invoice** (idempotency)

## Products (admin)

- [ ] Deactivate product → hidden from POS scan → checkout returns error
- [ ] Reactivate product → sale works again
- [ ] Negative-stock tab lists oversold items

## Refunds

- [ ] Cashier submits refund request
- [ ] Admin approves in office panel → request leaves pending list
- [ ] Cashier sees green/red notification → acknowledge
- [ ] (If Telegram configured) Approve via Telegram → admin panel updates on next poll
- [ ] Approve same request from second channel → **second attempt blocked** (stale message)

## Reports (office)

- [ ] Today's sales on dashboard matches sum of transactions
- [ ] Profit report unchanged after editing product cost (old sales)
- [ ] Shift audit CSV export opens safely in Excel (no formula execution)

## Inventory

- [ ] Stock adjustment posts correctly
- [ ] Inventory count session posts variances
- [ ] Ledger movement appears for sale and refund

## Resilience

- [ ] Restart backend server → frontends reconnect; data intact
- [ ] Restore from latest backup file on test copy → verify one transaction

## Sign-off

| Role | Name | Date | Pass/Fail |
|---|---|---|---|
| Store owner | | | |
| Head cashier | | | |
| IT / deployer | | | |

**Overall readiness estimate after automated fix phase + this checklist: ~85%** — remaining 15% is hardware, LAN load, and operator training.
