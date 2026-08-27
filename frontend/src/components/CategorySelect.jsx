import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { Select } from "./ui";

export default function CategorySelect({
  value = "",
  onChange,
  disabled = false,
  emptyLabel = "بدون تصنيف",
}) {
  const [categories, setCategories] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/products/categories", {
        params: { active: 1 },
        headers: getAuthHeaders(),
      })
      .then(({ data }) => {
        if (cancelled) return;
        setCategories(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setCategories([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = value || "";
  const known = new Set(categories.map((c) => c.name));
  const legacy = current && !known.has(current) ? current : null;

  return (
    <Select value={current} onChange={onChange} disabled={disabled}>
      <option value="">{emptyLabel}</option>
      {legacy ? <option value={legacy}>{legacy}</option> : null}
      {categories.map((c) => (
        <option key={c.id} value={c.name}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}
