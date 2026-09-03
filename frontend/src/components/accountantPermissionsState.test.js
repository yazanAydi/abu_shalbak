import {
  setAllEnabled,
  setTopicEnabled,
  toggleFeature,
  topicSummary,
} from "./accountantPermissionsState";
import { permissionTopicsFromNav } from "./layout/officeNavConfig";
import {
  allAccountantPermissionKeys,
  allAccountantPermissionsDisabled,
} from "../utils/accountantPermissions";

const NONE = allAccountantPermissionsDisabled();
const topics = permissionTopicsFromNav();
const catalog = topics.find((t) => t.id === "catalog");
const finance = topics.find((t) => t.id === "finance");

describe("permissions panel state", () => {
  test("toggling one feature leaves the others untouched", () => {
    const next = toggleFeature(NONE, "suppliers", true);
    expect(next.suppliers).toBe(true);
    expect(next.customers).toBe(false);
    expect(Object.keys(next)).toHaveLength(Object.keys(NONE).length);
    expect(toggleFeature(next, "suppliers", false).suppliers).toBe(false);
  });

  test("group تحديد الكل enables only that group's children", () => {
    const next = setTopicEnabled(NONE, catalog, true);
    for (const f of catalog.features) expect(next[f.key]).toBe(true);
    for (const f of finance.features) expect(next[f.key]).toBe(false);
  });

  test("group إلغاء الكل disables only that group's children", () => {
    const all = setAllEnabled(true);
    const next = setTopicEnabled(all, catalog, false);
    for (const f of catalog.features) expect(next[f.key]).toBe(false);
    for (const f of finance.features) expect(next[f.key]).toBe(true);
  });

  test("global تحديد الكل / إلغاء الكل covers every catalog key", () => {
    const on = setAllEnabled(true);
    const off = setAllEnabled(false);
    for (const key of allAccountantPermissionKeys()) {
      expect(on[key]).toBe(true);
      expect(off[key]).toBe(false);
    }
  });

  test("summary counts the enabled children of a group", () => {
    expect(topicSummary(NONE, catalog)).toBe(`0/${catalog.features.length}`);
    const some = toggleFeature(NONE, catalog.features[0].key, true);
    expect(topicSummary(some, catalog)).toBe(`1/${catalog.features.length}`);
    expect(topicSummary(setAllEnabled(true), catalog)).toBe(
      `${catalog.features.length}/${catalog.features.length}`
    );
  });
});
