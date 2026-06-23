import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../apiClient";
import { getAuthHeaders, getUser } from "../utils/auth";
import { isAdminRole } from "../utils/roles";
import "./ProductManagement.css";

const PAGE = 50;

export default function ProductManagement() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [uploadFeedback, setUploadFeedback] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [form, setForm] = useState({
    barcode: "",
    name: "",
    name_en: "",
    price: "",
    cost: "",
    category: "",
    stock: "",
    tax_rate: "",
    unit: "",
    expiry_date: "",
    min_price: "",
    max_price: "",
  });
  const [formErr, setFormErr] = useState(null);
  const [editId, setEditId] = useState(null);
  const [edit, setEdit] = useState({ name: "", price: "", stock: "", tax_rate: "", unit: "", expiry_date: "" });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/products", {
        headers: getAuthHeaders(),
      });
      setProducts(Array.isArray(data) ? data : []);
    } catch (e) {
      window.alert(e.response?.data?.error || e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        String(p.barcode).toLowerCase().includes(q) ||
        String(p.name).toLowerCase().includes(q)
    );
  }, [products, search]);

  const pageSlice = useMemo(() => {
    const start = page * PAGE;
    return filtered.slice(start, start + PAGE);
  }, [filtered, page]);

  useEffect(() => {
    setPage(0);
  }, [search]);

  async function onUpload(ev) {
    const file = ev.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setUploadFeedback(null);
    const fd = new FormData();
    fd.append("file", file);
    try {
      const { data } = await api.post("/api/admin/products/upload", fd);
      setUploadFeedback({
        ok: true,
        text: data.message || `تمت إضافة ${data.inserted} منتجًا`,
      });
      await load();
    } catch (e) {
      if (e.response?.status === 401) {
        setUploadFeedback({
          ok: false,
          text:
            "انتهت الجلسة أو غير صالحة — سجّل الخروج ثم الدخول كمسؤول وأعد رفع الملف.",
        });
        return;
      }
      const noResponse = !e.response;
      const net =
        noResponse &&
        (e.code === "ERR_NETWORK" ||
          String(e.message || "").includes("Network Error"));
      const text = net
        ? "تعذّر الاتصال بالخادم. شغّل الخادم في طرفية أخرى: من مجلد backend نفّذ npm start — اتركه يعمل (مثلاً المنفذ 5000) ثم أعد المحاولة."
        : e.response?.data?.detail ||
          e.response?.data?.error ||
          e.message ||
          "فشل الرفع";
      setUploadFeedback({ ok: false, text });
    } finally {
      setUploading(false);
      ev.target.value = "";
    }
  }

  async function addProduct(ev) {
    ev.preventDefault();
    setFormErr(null);
    try {
      await api.post(
        "/api/products",
        {
          barcode: form.barcode.trim(),
          name: form.name.trim(),
          name_en: form.name_en?.trim() || null,
          price: Number(form.price),
          cost: form.cost === "" ? 0 : Number(form.cost),
          category: form.category.trim() || null,
          stock: Number(form.stock),
          tax_rate: form.tax_rate !== "" ? Number(form.tax_rate) : null,
          unit: form.unit?.trim() || null,
          expiry_date: form.expiry_date?.trim() || null,
          min_price: form.min_price !== "" ? Number(form.min_price) : null,
          max_price: form.max_price !== "" ? Number(form.max_price) : null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setForm({
        barcode: "",
        name: "",
        name_en: "",
        price: "",
        cost: "",
        category: "",
        stock: "",
        tax_rate: "",
        unit: "",
        expiry_date: "",
        min_price: "",
        max_price: "",
      });
      await load();
    } catch (e) {
      setFormErr(e.response?.data?.error || e.message);
    }
  }

  function openEdit(p) {
    setEditId(p.id);
    setEdit({
      name: p.name,
      price: String(p.price),
      stock: String(p.stock),
      tax_rate: p.tax_rate != null ? String(p.tax_rate) : "",
      unit: p.unit || "",
      expiry_date: p.expiry_date || "",
    });
  }

  async function saveEdit() {
    if (!editId) return;
    try {
      await api.put(
        `/api/products/${editId}`,
        {
          name: edit.name.trim(),
          price: Number(edit.price),
          stock: Number(edit.stock),
          tax_rate: edit.tax_rate !== "" ? Number(edit.tax_rate) : null,
          unit: edit.unit?.trim() || null,
          expiry_date: edit.expiry_date?.trim() || null,
        },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      setEditId(null);
      await load();
    } catch (e) {
      window.alert(e.response?.data?.error || e.message);
    }
  }

  async function delProduct(id) {
    if (!window.confirm("حذف هذا المنتج؟")) return;
    try {
      await api.delete(`/api/admin/products/${id}`, {
        headers: getAuthHeaders(),
      });
      await load();
    } catch (e) {
      window.alert(e.response?.data?.error || e.message);
    }
  }

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE));
  const u = getUser();

  return (
    <div className="pm-page" dir="rtl" lang="ar">
      <div className="pm-top">
        <Link to="/checkout" className="pm-back">
          ← الكاشير
        </Link>
        {isAdminRole(u?.role) ? (
          <span className="pm-top-links">
            <Link to="/reports" className="pm-top-link">
              تقرير يومي
            </Link>
            <Link to="/finance" className="pm-top-link">
              المالية
            </Link>
            <Link to="/manage-users" className="pm-top-link">
              الحسابات
            </Link>
          </span>
        ) : null}
      </div>

      <section className="pm-section">
        <h2>رفع منتجات (CSV أو Excel)</h2>
        <p className="pm-hint">
          أعمدة CSV: barcode، name، price، cost، category، stock — أو Excel (.xlsx) بعناوين
          عربية/إنجليزية (باركود، الاسم، السعر، …). يُستخدم الورقة الأولى؛ المخزون 0 إن وُضع
          فارغًا.
        </p>
        <input
          type="file"
          accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          onChange={onUpload}
          disabled={uploading}
        />
        {uploading ? <p>جاري الرفع…</p> : null}
        {uploadFeedback ? (
          <p className={uploadFeedback.ok ? "pm-msg" : "pm-err"}>
            {uploadFeedback.text}
          </p>
        ) : null}
      </section>

      <section className="pm-section">
        <h2>إضافة منتج</h2>
        <form className="pm-form" onSubmit={addProduct}>
          <input
            placeholder="الباركود"
            value={form.barcode}
            onChange={(e) => setForm({ ...form, barcode: e.target.value })}
            required
          />
          <input
            placeholder="الاسم"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
          <input
            placeholder="سعر البيع"
            type="number"
            step="0.01"
            value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            required
          />
          <input
            placeholder="تكلفة (اختياري)"
            type="number"
            step="0.01"
            value={form.cost}
            onChange={(e) => setForm({ ...form, cost: e.target.value })}
          />
          <input
            placeholder="التصنيف"
            value={form.category}
            onChange={(e) => setForm({ ...form, category: e.target.value })}
          />
          <input
            placeholder="المخزون"
            type="number"
            value={form.stock}
            onChange={(e) => setForm({ ...form, stock: e.target.value })}
            required
          />
          <input
            placeholder="نسبة الضريبة (0-1، مثال: 0.16)"
            type="number"
            step="0.01"
            min="0"
            max="1"
            value={form.tax_rate}
            onChange={(e) => setForm({ ...form, tax_rate: e.target.value })}
          />
          <input
            placeholder="الوحدة (حبة/كيلو/كرتون)"
            value={form.unit}
            onChange={(e) => setForm({ ...form, unit: e.target.value })}
          />
          <input
            placeholder="تاريخ الصلاحية (YYYY-MM-DD)"
            type="date"
            value={form.expiry_date}
            onChange={(e) => setForm({ ...form, expiry_date: e.target.value })}
          />
          <button type="submit">إضافة المنتج</button>
        </form>
        {formErr ? <p className="pm-err">{formErr}</p> : null}
      </section>

      <section className="pm-section">
        <h2>المنتجات</h2>
        <input
          className="pm-search"
          placeholder="بحث بالباركود أو الاسم"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        {loading ? (
          <p>جاري التحميل…</p>
        ) : (
          <>
            <div className="table-wrap">
              <table className="pm-table">
                <thead>
                  <tr>
                    <th>الباركود</th>
                    <th>الاسم</th>
                    <th>السعر</th>
                    <th>المخزون</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {pageSlice.map((p) => (
                    <tr key={p.id}>
                      <td>{p.barcode}</td>
                      <td>{p.name}</td>
                      <td>{Number(p.price).toFixed(2)}</td>
                      <td>{p.stock}</td>
                      <td className="pm-actions">
                        <button type="button" onClick={() => openEdit(p)}>
                          تعديل
                        </button>
                        <button type="button" onClick={() => delProduct(p.id)}>
                          حذف
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="pm-pager">
              <button
                type="button"
                disabled={page <= 0}
                onClick={() => setPage((p) => p - 1)}
              >
                السابق
              </button>
              <span>
                صفحة {page + 1} / {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages - 1}
                onClick={() => setPage((p) => p + 1)}
              >
                التالي
              </button>
            </div>
          </>
        )}
      </section>

      {editId ? (
        <div className="pm-modal-backdrop">
          <div className="pm-modal">
            <h3>تعديل المنتج</h3>
            <input
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
            />
            <input
              type="number"
              step="0.01"
              value={edit.price}
              onChange={(e) => setEdit({ ...edit, price: e.target.value })}
            />
            <input
              type="number"
              value={edit.stock}
              onChange={(e) => setEdit({ ...edit, stock: e.target.value })}
            />
            <input
              type="number"
              step="0.01"
              min="0"
              max="1"
              placeholder="نسبة الضريبة (0-1)"
              value={edit.tax_rate}
              onChange={(e) => setEdit({ ...edit, tax_rate: e.target.value })}
            />
            <input
              placeholder="الوحدة"
              value={edit.unit}
              onChange={(e) => setEdit({ ...edit, unit: e.target.value })}
            />
            <input
              type="date"
              placeholder="تاريخ الصلاحية"
              value={edit.expiry_date}
              onChange={(e) => setEdit({ ...edit, expiry_date: e.target.value })}
            />
            <div className="pm-modal-btns">
              <button type="button" onClick={saveEdit}>
                حفظ
              </button>
              <button type="button" onClick={() => setEditId(null)}>
                إلغاء
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
