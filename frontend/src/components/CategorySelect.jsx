import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { Select } from "./ui";

export default function CategorySelect({
  value = "",
  onChange,
  disabled = false,
  emptyLabel = "غير مصنف",
  categories: categoriesProp,
  allowEmpty = true,
  missingValue,
  missingLabel,
}) {
  const [loaded, setLoaded] = useState([]);

  useEffect(() => {
    if (categoriesProp !== undefined) return undefined;
    let cancelled = false;
    api
      .get("/api/products/categories", {
        params: { active: 1 },
        headers: getAuthHeaders(),
      })
      .then(({ data }) => {
        if (cancelled) return;
        setLoaded(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setLoaded([]);
      });
    return () => {
      cancelled = true;
    };
  }, [categoriesProp]);

  const categories = categoriesProp !== undefined ? categoriesProp : loaded;
  const current = value || "";
  const known = new Set(categories.map((c) => c.name));
  const legacy =
    current && current !== missingValue && !known.has(current) ? current : null;

  return (
    <Select value={current} onChange={onChange} disabled={disabled}>
      {allowEmpty ? <option value="">{emptyLabel}</option> : null}
      {missingValue ? <option value={missingValue}>{missingLabel}</option> : null}
      {legacy ? <option value={legacy}>{legacy}</option> : null}
      {categories.map((c) => (
        <option key={c.id ?? c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}
