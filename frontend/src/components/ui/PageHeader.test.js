import { act } from "react";
import { createRoot } from "react-dom/client";
import PageHeader from "./PageHeader";
import { PageRefreshContext } from "../layout/PageRefreshContext";

function render(ui) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(ui);
  });
  return {
    container,
    unmount() {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("PageHeader refresh", () => {
  it("shows تحديث and calls the shared refresh", () => {
    const refreshPage = jest.fn();
    const { container, unmount } = render(
      <PageRefreshContext.Provider value={{ refreshPage, refreshing: false, pageKey: 0 }}>
        <PageHeader title="المنتجات" />
      </PageRefreshContext.Provider>
    );
    const btn = [...container.querySelectorAll("button")].find((el) => el.textContent.includes("تحديث"));
    expect(btn).toBeTruthy();
    act(() => {
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(refreshPage).toHaveBeenCalledTimes(1);
    unmount();
  });

  it("hides تحديث when refresh is disabled", () => {
    const refreshPage = jest.fn();
    const { container, unmount } = render(
      <PageRefreshContext.Provider value={{ refreshPage, refreshing: false, pageKey: 0 }}>
        <PageHeader title="المنتجات" refresh={false} />
      </PageRefreshContext.Provider>
    );
    const btn = [...container.querySelectorAll("button")].find((el) => el.textContent.includes("تحديث"));
    expect(btn).toBeFalsy();
    unmount();
  });
});
