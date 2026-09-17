import { getFocusableFields, getNavRoot, shouldHandleEnterOnField } from "./focusNavigation";

describe("focusNavigation", () => {
  function field(tag, attrs = {}) {
    const el = document.createElement(tag);
    Object.entries(attrs).forEach(([k, v]) => {
      if (k === "type") el.type = v;
      else if (k === "readOnly") el.readOnly = v;
      else if (k === "disabled") el.disabled = v;
      else el.setAttribute(k, v);
    });
    return el;
  }

  test("skips readonly, hidden, and skipped fields", () => {
    const root = document.createElement("div");
    root.setAttribute("data-enter-nav", "");
    const a = field("input", { type: "text" });
    const b = field("input", { type: "text", readOnly: true });
    const c = field("textarea");
    const skipWrap = document.createElement("div");
    skipWrap.setAttribute("data-enter-nav-skip", "");
    const d = field("input", { type: "text" });
    skipWrap.appendChild(d);
    root.append(a, b, c, skipWrap);
    document.body.appendChild(root);
    const fields = getFocusableFields(root);
    expect(fields).toEqual([a, c]);
    root.remove();
  });

  test("nav root prefers the nearest data-enter-nav scope", () => {
    const modal = document.createElement("div");
    modal.className = "ui-modal__body";
    const inner = document.createElement("div");
    inner.setAttribute("data-enter-nav", "invoice-lines");
    const input = field("input", { type: "text" });
    inner.appendChild(input);
    modal.appendChild(inner);
    document.body.appendChild(modal);
    expect(getNavRoot(input)).toBe(inner);
    modal.remove();
  });

  test("open combobox is not advanced by Enter", () => {
    const input = field("input", { type: "text", role: "combobox", "aria-expanded": "true" });
    expect(shouldHandleEnterOnField(input, { key: "Enter" })).toBe(false);
  });

  test("open party picker combobox is not advanced by Enter", () => {
    const root = document.createElement("div");
    root.className = "party-picker";
    const input = field("input", { type: "text", role: "combobox", "aria-expanded": "true" });
    root.appendChild(input);
    document.body.appendChild(root);
    expect(shouldHandleEnterOnField(input, { key: "Enter" })).toBe(false);
    root.remove();
  });

  test("Enter in a textarea does not move focus", () => {
    const el = field("textarea");
    expect(shouldHandleEnterOnField(el, { key: "Enter" })).toBe(false);
  });
});
