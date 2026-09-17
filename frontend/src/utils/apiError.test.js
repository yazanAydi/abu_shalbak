import { apiErrorDetails, apiErrorMessage } from "./apiError";

describe("apiErrorMessage", () => {
  it("prefers backend envelope error", () => {
    expect(apiErrorMessage({ response: { data: { error: "الاسم مطلوب" } } }, "فشل")).toBe("الاسم مطلوب");
  });

  it("maps status codes to Arabic", () => {
    expect(apiErrorMessage({ response: { status: 403 } })).toBe("لا تملك صلاحية");
    expect(apiErrorMessage({ response: { status: 404 } })).toBe("غير موجود");
    expect(apiErrorMessage({ response: { status: 409 } })).toBe("تعارض في البيانات");
    expect(apiErrorMessage({ response: { status: 400 } })).toBe("بيانات غير صالحة");
    expect(apiErrorMessage({ response: { status: 500 } })).toBe("خطأ في الخادم، حاول لاحقاً");
  });

  it("maps network errors", () => {
    expect(apiErrorMessage({ message: "Network Error" })).toMatch(/تعذّر الاتصال/);
  });

  it("uses fallback for empty errors", () => {
    expect(apiErrorMessage(null, "تعذّر التحميل")).toBe("تعذّر التحميل");
  });
});

describe("apiErrorDetails", () => {
  it("includes status and requestId", () => {
    const details = apiErrorDetails({
      message: "Request failed",
      response: { status: 500, data: { error: "boom", meta: { requestId: "abc" } } },
    });
    expect(details).toContain("status: 500");
    expect(details).toContain("requestId: abc");
    expect(details).toContain("boom");
  });
});
