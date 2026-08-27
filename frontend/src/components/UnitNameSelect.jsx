import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { Select } from "./ui";

export default function UnitNameSelect({
  value = "",
  onChange,
  disabled = false,
  emptyLabel = "اختر الوحدة",
}) {
  const [names, setNames] = useState([]);

  useEffect(() => {
    let cancelled = false;
    api
      .get("/api/products/unit-names", {
        params: { active: 1 },
        headers: getAuthHeaders(),
      })
      .then(({ data }) => {
        if (cancelled) return;
        setNames(Array.isArray(data) ? data : []);
      })
      .catch(() => {
        if (!cancelled) setNames([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const current = value || "";
  const known = new Set(names.map((c) => c.name));
  const legacy = current && !known.has(current) ? current : null;

  return (
    <Select value={current} onChange={onChange} disabled={disabled}>
      <option value="">{emptyLabel}</option>
      {legacy ? <option value={legacy}>{legacy}</option> : null}
      {names.map((c) => (
        <option key={c.id} value={c.name}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}
