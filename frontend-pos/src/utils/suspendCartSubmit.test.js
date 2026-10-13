import { buildSuspendRequest, resolveSuspendAttempt, suspendPayloadSignature } from "./suspendCartSubmit";

const item = { id: 7, unitId: 3, quantity: 2, price: 10, scanned_barcode: "123" };

describe("suspend cart request", () => {
  test("a new cart posts once and a restored cart puts the same id", () => {
    const created = resolveSuspendAttempt({ activeSaleId: null, outstandingKey: null });
    expect(created.mode).toBe("create");
    const post = buildSuspendRequest({
      items: [item],
      note: "ملاحظة",
      customerId: 4,
      idempotencyKey: created.idempotencyKey,
    });
    expect(post.method).toBe("post");
    expect(post.body.idempotency_key).toBe(created.idempotencyKey);
    expect(post.body.customer_id).toBe(4);
    expect(post.body.items[0]).toMatchObject({ product_id: 7, unit_id: 3, quantity: 2, price: 10 });

    const again = resolveSuspendAttempt({ activeSaleId: 15, outstandingKey: created.idempotencyKey });
    expect(again.mode).toBe("update");
    const put = buildSuspendRequest({
      saleId: 15,
      items: [{ ...item, quantity: 5 }],
      version: 2,
      note: "ملاحظة",
    });
    expect(put.method).toBe("put");
    expect(put.url).toBe("/api/suspended-sales/15");
    expect(put.body.version).toBe(2);
    expect(put.body.idempotency_key).toBeUndefined();
  });

  test("an unanswered create keeps the same idempotency key", () => {
    const first = resolveSuspendAttempt({ activeSaleId: null, outstandingKey: null });
    const retry = resolveSuspendAttempt({ activeSaleId: null, outstandingKey: first.idempotencyKey });
    expect(retry.idempotencyKey).toBe(first.idempotencyKey);
    expect(retry.reuse).toBe(true);
  });

  test("checkout sync sends the version and leaves party fields off the body", () => {
    const req = buildSuspendRequest({
      saleId: 9,
      items: [item],
      version: 4,
      preserveParty: true,
      customerId: 3,
      note: "لا تُرسل",
    });
    expect(req.body.version).toBe(4);
    expect(req.body.customer_id).toBeUndefined();
    expect(req.body.note).toBeUndefined();
  });

  test("signature changes when the saved cart changes", () => {
    const a = suspendPayloadSignature([item], { note: null, customerId: null });
    const b = suspendPayloadSignature([{ ...item, quantity: 3 }], { note: null, customerId: null });
    expect(a).not.toBe(b);
  });
});
