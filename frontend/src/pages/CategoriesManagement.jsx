import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import {
  PageHeader,
  Button,
  DataTable,
  Modal,
  StatusPill,
  FormField,
  FormGrid,
  Input,
  useToast,
} from "../components/ui";

export default function CategoriesManagement() {
  const toast = useToast();
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");
  const [editing, setEditing] = useState(null);
  const [editName, setEditName] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const { data } = await api.get("/api/products/categories", {
        headers: getAuthHeaders(),
      });
      setCategories(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.response?.data?.error || "تعذّر تحميل التصنيفات");
    } finally {
      setLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  async function saveNew() {
    const name = newName.trim();
    if (!name) {
      toast.error("اسم التصنيف مطلوب");
      return;
    }
    setSaving(true);
    try {
      await api.post("/api/products/categories", { name }, { headers: getAuthHeaders() });
      toast.success("تمت الإضافة");
      setShowAdd(false);
      setNewName("");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function saveEdit() {
    if (!editing?.id) return;
    const name = editName.trim();
    if (!name) {
      toast.error("اسم التصنيف مطلوب");
      return;
    }
    setSaving(true);
    try {
      await api.put(
        `/api/products/categories/${editing.id}`,
        { name },
        { headers: getAuthHeaders() }
      );
      toast.success("تم حفظ الاسم");
      setEditing(null);
      setEditName("");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الحفظ");
    } finally {
      setSaving(false);
    }
  }

  async function remove(row) {
    if (!window.confirm(`حذف التصنيف «${row.name}»؟`)) return;
    try {
      const { data } = await api.delete(`/api/products/categories/${row.id}`, {
        headers: getAuthHeaders(),
      });
      toast.success(data?.deactivated ? "التصنيف مستخدم — تم تعطيله" : "تم الحذف");
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل الحذف");
    }
  }

  async function toggleActive(row) {
    try {
      await api.put(
        `/api/products/categories/${row.id}`,
        { active: row.active ? 0 : 1 },
        { headers: getAuthHeaders() }
      );
      load();
    } catch (e) {
      toast.error(e.response?.data?.error || e.message || "فشل التحديث");
    }
  }

  const columns = [
    { key: "name", header: "الاسم" },
    {
      key: "active",
      header: "الحالة",
      value: (c) => (c.active ? "مفعّل" : "معطّل"),
      render: (c) => (
        <StatusPill tone={c.active ? "green" : "neutral"}>
          {c.active ? "مفعّل" : "معطّل"}
        </StatusPill>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "left",
      render: (c) => (
        <span style={{ display: "inline-flex", gap: "0.4rem", flexWrap: "wrap" }}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setEditing(c);
              setEditName(c.name);
            }}
          >
            تعديل
          </Button>
          <Button variant="ghost" size="sm" onClick={() => toggleActive(c)}>
            {c.active ? "تعطيل" : "تفعيل"}
          </Button>
          <Button variant="ghost" size="sm" icon="trash" onClick={() => remove(c)} />
        </span>
      ),
    },
  ];

  return (
    <div className="office-page" dir="rtl" lang="ar">
      <PageHeader
        icon="products"
        title="التصنيفات"
        subtitle="أضف التصنيفات هنا ثم اخترها عند إضافة أو تعديل منتج"
        actions={
          <Button icon="plus" onClick={() => setShowAdd(true)}>
            تصنيف جديد
          </Button>
        }
      />

      <DataTable
        loading={loading}
        columns={columns}
        rows={categories}
        emptyIcon="products"
        empty="لا توجد تصنيفات — أضف تصنيفاً لتظهر في قائمة المنتجات"
      />

      <Modal
        open={showAdd}
        title="تصنيف جديد"
        onClose={() => {
          if (!saving) {
            setShowAdd(false);
            setNewName("");
          }
        }}
        footer={
          <>
            <Button onClick={saveNew} disabled={saving}>
              {saving ? "جاري الحفظ…" : "حفظ"}
            </Button>
            <Button variant="secondary" onClick={() => setShowAdd(false)} disabled={saving}>
              إلغاء
            </Button>
          </>
        }
      >
        <FormGrid>
          <FormField label="اسم التصنيف" required>
            <Input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              autoFocus
            />
          </FormField>
        </FormGrid>
      </Modal>

      <Modal
        open={!!editing}
        title="تعديل التصنيف"
        onClose={() => {
          if (!saving) {
            setEditing(null);
            setEditName("");
          }
        }}
        footer={
          <>
            <Button onClick={saveEdit} disabled={saving}>
              {saving ? "جاري الحفظ…" : "حفظ"}
            </Button>
            <Button
              variant="secondary"
              onClick={() => {
                setEditing(null);
                setEditName("");
              }}
              disabled={saving}
            >
              إلغاء
            </Button>
          </>
        }
      >
        <FormGrid>
          <FormField label="اسم التصنيف" required>
            <Input
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              autoFocus
            />
          </FormField>
        </FormGrid>
      </Modal>
    </div>
  );
}
