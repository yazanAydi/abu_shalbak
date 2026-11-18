import { act } from "react";
import { createRoot } from "react-dom/client";
import InventoryCount from "./InventoryCount";
import { ToastProvider } from "../components/ui";
import api from "../apiClient";
import { searchProductsApi } from "../utils/productSearch";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: { get: jest.fn(), post: jest.fn() },
}));
jest.mock("../hooks/useAuthUser", () => ({ __esModule: true, default: () => ({ role: "accountant" }) }));
jest.mock("../utils/productSearch", () => ({ searchProductsApi: jest.fn() }));
jest.mock("../components/ui", () => ({
  ...jest.requireActual("../components/ui"),
  ReportToolbar: () => null,
}));

function line(id, overrides = {}) {
  return {
    id, product_id: id, name: `صنف ${id}`, unit: "حبة", counted_qty: id,
    system_qty: id, batch_source: null, expiry_date: null, warehouse_id: 1,
    ...overrides,
  };
}

function picture(id) {
  return {
    product_id: id, has_dated_batches: false, product_stock: id,
    unit: "حبة", product_expiry_date: null, main_warehouse_id: 1, sources: [],
    locations: [{ warehouse_id: 1, warehouse_type: "main", expiry_date: null, quantity: id }],
    count_units: [{ id: id * 100 + 1, unit_name: "كرتونة", conversion_to_base: 6 }],
  };
}

describe("InventoryCount batched save and post", () => {
  let container;
  let root;
  let session;
  let confirm;

  beforeEach(() => {
    session = { id: 14, department: "retail", status: "open", lines: [line(1)] };
    api.get.mockReset();
    api.post.mockReset();
    searchProductsApi.mockReset();
    searchProductsApi.mockResolvedValue([{ id: 2, name: "صنف جديد", unit: "حبة" }]);
    api.get.mockImplementation(async (url, config) => {
      if (url === "/api/inventory/counts") return { data: [{ id: 14, department: "retail", status: session.status }] };
      if (url === "/api/inventory/counts/14") return { data: session };
      if (url === "/api/inventory/stock-sources") return { data: picture(config.params.product_id) };
      return { data: {} };
    });
    api.post.mockImplementation(async (url, body) => {
      if (url === "/api/inventory/stock-sources/batch") {
        return { data: { pictures: Object.fromEntries(body.product_ids.map((id) => [id, picture(id)])) } };
      }
      if (url === "/api/inventory/counts/14/lines/bulk") {
        const byProduct = new Map(session.lines.map((row) => [row.product_id, [row]]));
        for (const product of body.products) {
          byProduct.set(product.product_id, product.sources.map((source) => line(product.product_id, {
            ...source,
            count_unit_snapshot: source.count_unit_snapshot
              ? JSON.stringify({ ...source.count_unit_snapshot,
                  unit_name: source.count_unit_snapshot.unit_id == null ? "حبة" : "كرتونة" })
              : null,
          })));
        }
        session = { ...session, lines: [...byProduct.values()].flat() };
        return { data: session };
      }
      if (url === "/api/inventory/counts/14/post") {
        session = { ...session, status: "posted" };
        return { data: session };
      }
      throw new Error(`Unexpected POST ${url}`);
    });
    confirm = jest.spyOn(window, "confirm").mockReturnValue(true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    confirm.mockRestore();
  });

  function button(text) {
    return [...container.querySelectorAll("button")].find((node) => node.textContent === text);
  }

  async function openSession() {
    await act(async () => root.render(<ToastProvider><InventoryCount embedded /></ToastProvider>));
    await act(async () => button("عرض").click());
  }

  async function enter(input, value) {
    await act(async () => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("152 products post with two bounded source reads, one atomic save and one post", async () => {
    session.lines = Array.from({ length: 152 }, (_, index) => line(index + 1));
    await openSession();
    expect(api.post.mock.calls.filter(([url]) => url.endsWith("/stock-sources/batch"))
      .map(([, body]) => body.product_ids.length)).toEqual([100, 52]);
    api.post.mockClear();
    api.get.mockClear();

    await act(async () => button("ترحيل الجرد").click());

    expect(api.post.mock.calls.map(([url]) => url)).toEqual([
      "/api/inventory/stock-sources/batch",
      "/api/inventory/stock-sources/batch",
      "/api/inventory/counts/14/lines/bulk",
      "/api/inventory/counts/14/post",
    ]);
    expect(api.post.mock.calls[0][1].product_ids).toHaveLength(100);
    expect(api.post.mock.calls[1][1].product_ids).toHaveLength(52);
    expect(api.post.mock.calls[2][1].products).toHaveLength(152);
    expect(api.get.mock.calls.some(([url]) => url === "/api/inventory/counts/14" || url.endsWith("/stock-sources"))).toBe(false);
    expect(container.textContent).toContain("تم ترحيل الجرد وتحديث المخزون");
  });

  test("atomic save keeps entered units, dates and zero quantities and clears removed products", async () => {
    session.lines = [line(1), line(2), line(3)];
    await openSession();
    const rows = container.querySelectorAll("[data-invoice-line]");
    await enter(rows[0].querySelector("[data-testid='count-qty']"), "2");
    const unit = rows[0].querySelector("[data-testid='count-unit']");
    await act(async () => {
      unit.value = "101";
      unit.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await enter(rows[0].querySelector("[data-invoice-field='expiry']"), "15/01/28");
    await act(async () => rows[0].querySelector("[data-testid='count-expiry-verified']").click());
    await enter(rows[1].querySelector("[data-testid='count-qty']"), "0");
    await act(async () => rows[2].querySelector("[aria-label='حذف']").click());
    api.post.mockClear();
    api.get.mockClear();

    await act(async () => button("حفظ الجرد").click());

    const save = api.post.mock.calls.find(([url]) => url.endsWith("/lines/bulk"));
    expect(save[1]).toEqual({ department: "retail", products: [
      { product_id: 3, sources: [] },
      { product_id: 1, sources: [{ batch_source: "dated", expiry_date: "2028-01-15", counted_qty: 12,
        expiry_verified: true, count_unit_snapshot: { unit_id: 101, conversion_to_base: 6 } }] },
      { product_id: 2, sources: [{ batch_source: null, expiry_date: null, counted_qty: 0 }] },
    ] });
    expect(api.post).toHaveBeenCalledTimes(2);
    expect(api.get).not.toHaveBeenCalled();
    expect([...container.querySelectorAll("[data-testid='count-qty']")].map((input) => input.value)).toEqual(["2", "0"]);
    expect(container.querySelector("[data-testid='count-unit']").value).toBe("101");
    expect(container.querySelector("[data-invoice-field='expiry']").value).toBe("15/01/28");
    expect(container.textContent).toContain("تم حفظ الجرد");
  });

  test.each(["حفظ الجرد", "ترحيل الجرد"])("%s failure keeps draft edits and does not post or reload", async (action) => {
    await openSession();
    await enter(container.querySelector("[data-testid='count-qty']"), "25");
    const handler = api.post.getMockImplementation();
    api.post.mockImplementation((url, body, config) => {
      if (url.endsWith("/lines/bulk")) return Promise.reject({ response: { status: 429, data: { error: "طلبات كثيرة — حاول لاحقاً" } } });
      return handler(url, body, config);
    });
    api.get.mockClear();
    await act(async () => button(action).click());
    expect(container.querySelector("[data-testid='count-qty']").value).toBe("25");
    expect(container.querySelector("[data-testid='count-qty']").readOnly).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
    expect(api.post.mock.calls.some(([url]) => url.endsWith("/14/post"))).toBe(false);
    expect(container.textContent).toContain("طلبات كثيرة — حاول لاحقاً");
  });

  test.each(["حفظ الجرد", "ترحيل الجرد"])("%s waits for a newly selected product's expiry before capturing the draft", async (action) => {
    await openSession();
    let release;
    const get = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) => {
      if (url === "/api/inventory/stock-sources" && config.params.product_id === 2) {
        return new Promise((resolve) => { release = resolve; });
      }
      return get(url, config);
    });
    await act(async () => button("إضافة صنف").click());
    const row = container.querySelectorAll("[data-invoice-line]")[1];
    const product = row.querySelector("[data-invoice-field='product']");
    await enter(product, "جديد");
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 350)); });
    await act(async () => product.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    await enter(row.querySelector("[data-testid='count-qty']"), "4");
    expect(row.querySelector("[data-invoice-field='expiry']").value).toBe("");
    api.post.mockClear();

    await act(async () => button(action).click());
    expect(api.post).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(container.textContent).toContain("انتظر اكتمال تحميل بيانات الأصناف");
    expect(row.querySelector("[data-testid='count-qty']").readOnly).toBe(false);

    await act(async () => release({ data: {
      ...picture(2), has_dated_batches: true,
      sources: [{ batch_source: "dated", expiry_date: "2028-01-15", quantity: 2 }],
    } }));
    expect(row.querySelector("[data-invoice-field='expiry']").value).toBe("15/01/28");
    await act(async () => button(action).click());
    const save = api.post.mock.calls.find(([url]) => url.endsWith("/lines/bulk"));
    const savedNewProduct = save[1].products.find((entry) => entry.product_id === 2);
    expect(savedNewProduct.sources).toEqual([{
      batch_source: "dated", expiry_date: "2028-01-15", counted_qty: 4,
      count_unit_snapshot: { unit_id: null, conversion_to_base: 1 },
    }]);
    expect(api.post.mock.calls.filter(([url]) => url.endsWith("/14/post"))).toHaveLength(action === "ترحيل الجرد" ? 1 : 0);
  });

  test("a failed initial picture read can recover through the fresh save batch", async () => {
    const get = api.get.getMockImplementation();
    api.get.mockImplementation((url, config) => (
      url === "/api/inventory/stock-sources" ? Promise.reject(new Error("Network Error")) : get(url, config)
    ));
    await openSession();
    expect(container.querySelector("[data-testid='count-unit']").disabled).toBe(true);
    await enter(container.querySelector("[data-testid='count-qty']"), "8");
    await act(async () => button("حفظ الجرد").click());
    expect(api.post.mock.calls.filter(([url]) => url.endsWith("/lines/bulk"))).toHaveLength(1);
    expect(container.querySelector("[data-testid='count-qty']").value).toBe("8");
    expect(container.querySelector("[data-testid='count-unit']").disabled).toBe(false);
    expect(container.textContent).toContain("تم حفظ الجرد");
  });

  test("duplicate clicks share one save and controls stay locked until posting completes", async () => {
    await openSession();
    const handler = api.post.getMockImplementation();
    let release;
    api.post.mockImplementation((url, body, config) => {
      if (url.endsWith("/lines/bulk")) {
        return new Promise((resolve) => { release = () => resolve(handler(url, body, config)); });
      }
      return handler(url, body, config);
    });
    await act(async () => {
      const post = button("ترحيل الجرد");
      post.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      post.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.post.mock.calls.filter(([url]) => url.endsWith("/lines/bulk"))).toHaveLength(1);
    expect(button("رجوع للقائمة").disabled).toBe(true);
    expect(button("حفظ الجرد").disabled).toBe(true);
    expect(container.querySelector("[data-testid='count-qty']").readOnly).toBe(true);
    expect(container.textContent).toContain("يرجى الانتظار");
    await act(async () => release());
    expect(api.post.mock.calls.filter(([url]) => url.endsWith("/14/post"))).toHaveLength(1);
    expect(container.textContent).toContain("تم ترحيل الجرد وتحديث المخزون");
  });
});
