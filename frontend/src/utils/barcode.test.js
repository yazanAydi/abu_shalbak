import { fetchBarcodeLookup, lookupProductByBarcode } from "./barcode";

const mockGet = jest.fn();

jest.mock("../apiClient", () => ({
  __esModule: true,
  default: {
    get: (...args) => mockGet(...args),
  },
}));

jest.mock("./auth", () => ({
  getAuthHeaders: () => ({ Authorization: "Bearer test" }),
}));

describe("admin barcode lookup", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  test("fetchBarcodeLookup uses /lookup and treats a free code as found:false", async () => {
    mockGet.mockResolvedValue({ data: { found: false } });
    const data = await fetchBarcodeLookup("7290000107189");
    expect(data).toEqual({ found: false });
    expect(mockGet).toHaveBeenCalledWith(
      "/api/products/lookup",
      expect.objectContaining({
        params: { barcode: "7290000107189" },
      })
    );
    expect(String(mockGet.mock.calls[0][0])).not.toMatch(/\/products\/729/);
  });

  test("lookupProductByBarcode throws on found:false without requiring a 404", async () => {
    mockGet.mockResolvedValue({ data: { found: false } });
    await expect(lookupProductByBarcode("111")).rejects.toThrow(/لم يُعثر على المنتج/);
  });

  test("lookupProductByBarcode returns the payload for an active product", async () => {
    mockGet.mockResolvedValue({
      data: { found: true, inactive: false, id: 9, name: "حليب" },
    });
    await expect(lookupProductByBarcode("6250001")).resolves.toMatchObject({
      id: 9,
      name: "حليب",
    });
  });
});
