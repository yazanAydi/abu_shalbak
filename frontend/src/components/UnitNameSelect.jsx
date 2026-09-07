import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { Select } from "./ui/Field";

export default function UnitNameSelect({
  value = "",
  onChange,
  disabled = false,
  emptyLabel = "منغير وحدة",
  names: namesProp,
  allowEmpty = true,
  missingValue,
  missingLabel,
}) {
  const [loaded, setLoaded] = useState([]);

  useEffect(() => {
    if (namesProp !== undefined) return undefined;
    let cancelled = false;
    api
      .get("/api/products/unit-names", {
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
  }, [namesProp]);

  const names = namesProp !== undefined ? namesProp : loaded;
  const current = value || "";
  const known = new Set(names.map((c) => c.name));
  const legacy =
    current && current !== missingValue && !known.has(current) ? current : null;

  return (
    <Select value={current} onChange={onChange} disabled={disabled}>
      {allowEmpty ? <option value="">{emptyLabel}</option> : null}
      {missingValue ? <option value={missingValue}>{missingLabel}</option> : null}
      {legacy ? <option value={legacy}>{legacy}</option> : null}
      {names.map((c) => (
        <option key={c.id ?? c.name} value={c.name}>
          {c.name}
        </option>
      ))}
    </Select>
  );
}
