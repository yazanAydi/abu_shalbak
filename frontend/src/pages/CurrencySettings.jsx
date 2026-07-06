import { useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { PageHeader, Card, CardBody, PrimaryButton, useToast } from "../components/ui";

export default function CurrencySettings() {
  const toast = useToast();
  const [currencies, setCurrencies] = useState([]);
  const [drafts, setDrafts] = useState({});
  const [loading, setLoading] = useState(true);
  const [savingId, setSavingId] = useState(null);
  const [error, setError] = useState(null);

  async function load() {
    setLoading(true);
    try {
      const { data } = await api.get("/api/currencies/all", { headers: getAuthHeaders() });
      const list = data?.currencies || [];
      setCurrencies(list);
      const d = {};
      for (const c of list) {
        d[c.id] = {
          name: c.name,
          symbol: c.symbol,
          exchange_rate_to_nis: c.exchange_rate_to_nis,
          enabled: !!c.enabled,
        };
      }
      setDrafts(d);
      setError(null);
    } catch {
      setError("تعذّر تحميل العملات");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  function updateDraft(id, key, value) {
    setDrafts((prev) => ({ ...prev, [id]: { ...prev[id], [key]: value } }));
  }

  async function save(currency) {
    const d = drafts[currency.id];
    if (!d) return;
    const rate = Number(d.exchange_rate_to_nis);
    if (!Number.isFinite(rate) || rate <= 0) {
      toast?.error?.("سعر الصرف يجب أن يكون أكبر من صفر");
      return;
    }
    setSavingId(currency.id);
    try {
      await api.patch(
        `/api/currencies/${currency.id}`,
        {
          name: String(d.name || "").trim(),
          symbol: String(d.symbol || "").trim(),
          exchange_rate_to_nis: rate,
          enabled: !!d.enabled,
        },
        { headers: getAuthHeaders() }
      );
      toast?.success?.("تم الحفظ");
      await load();
    } catch (e) {
      const msg = e?.response?.data?.error || "تعذّر الحفظ";
      toast?.error?.(msg);
    } finally {
      setSavingId(null);
    }
  }

  async function makeBase(currency) {
    if (currency.is_base) return;
    setSavingId(currency.id);
    try {
      await api.patch(
        `/api/currencies/${currency.id}`,
        { set_base: true },
        { headers: getAuthHeaders() }
      );
      toast?.success?.("تم تعيين العملة الأساسية");
      await load();
    } catch (e) {
      const msg = e?.response?.data?.error || "تعذّر التعيين";
      toast?.error?.(msg);
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        title="إعدادات العملات"
        subtitle="عملة المحاسبة دائماً الشيكل. اضبط أسعار الصرف لكل عملة (1 وحدة = X شيكل)."
        icon="settings"
      />

      {error && <div className="error-banner">{error}</div>}

      <Card>
        <CardBody>
          {loading ? (
            <p>جاري التحميل…</p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table className="data-table" style={{ width: "100%" }}>
                <thead>
                  <tr>
                    <th>العملة</th>
                    <th>الرمز</th>
                    <th>سعر الصرف (1 = ₪)</th>
                    <th>مفعّلة</th>
                    <th>الأساسية</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {currencies.map((c) => {
                    const d = drafts[c.id] || {};
                    return (
                      <tr key={c.id}>
                        <td>
                          <div style={{ fontWeight: 600 }}>{c.code}</div>
                          <input
                            type="text"
                            value={d.name ?? ""}
                            onChange={(e) => updateDraft(c.id, "name", e.target.value)}
                            style={{ width: 140 }}
                          />
                        </td>
                        <td>
                          <input
                            type="text"
                            value={d.symbol ?? ""}
                            onChange={(e) => updateDraft(c.id, "symbol", e.target.value)}
                            style={{ width: 60 }}
                          />
                        </td>
                        <td>
                          <input
                            type="number"
                            min="0"
                            step="0.0001"
                            value={d.exchange_rate_to_nis ?? 1}
                            disabled={c.is_base}
                            onChange={(e) =>
                              updateDraft(c.id, "exchange_rate_to_nis", e.target.value)
                            }
                            style={{ width: 110 }}
                          />
                          {c.is_base ? <small> (ثابت = 1)</small> : null}
                        </td>
                        <td style={{ textAlign: "center" }}>
                          <input
                            type="checkbox"
                            checked={!!d.enabled}
                            disabled={c.is_base}
                            onChange={(e) => updateDraft(c.id, "enabled", e.target.checked)}
                          />
                        </td>
                        <td style={{ textAlign: "center" }}>
                          {c.is_base ? (
                            <span style={{ fontWeight: 600 }}>✓ الأساسية</span>
                          ) : (
                            <button
                              type="button"
                              className="btn-secondary"
                              disabled={savingId === c.id}
                              onClick={() => makeBase(c)}
                            >
                              تعيين كأساسية
                            </button>
                          )}
                        </td>
                        <td>
                          <PrimaryButton
                            type="button"
                            disabled={savingId === c.id}
                            onClick={() => save(c)}
                          >
                            {savingId === c.id ? "جارٍ الحفظ…" : "حفظ"}
                          </PrimaryButton>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>
    </div>
  );
}
