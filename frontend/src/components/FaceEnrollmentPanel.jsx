import { useCallback, useEffect, useState } from "react";
import api from "../apiClient";
import { getAuthHeaders } from "../utils/auth";
import { useCameraVideo } from "../hooks/useCameraVideo";
import { useFaceRecognition } from "../hooks/useFaceRecognition";
import {
  Card,
  CardBody,
  DataTable,
  FormField,
  PrimaryButton,
  SecondaryButton,
  Select,
  StatusBadge,
  useToast,
} from "../components/ui";

const ROLE_LABELS = {
  cashier: "كاشير",
  bakery_employee: "موظف مخبز",
  shelves_employee: "موظف رفوف",
};

export default function FaceEnrollmentPanel() {
  const toast = useToast();
  const { videoRef, active, error: cameraError, start, stop } = useCameraVideo();
  const { ready, loading, error: modelError, extractDescriptor } = useFaceRecognition();

  const [employees, setEmployees] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [samples, setSamples] = useState([]);
  const [capturing, setCapturing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [listLoading, setListLoading] = useState(true);

  const loadEmployees = useCallback(async () => {
    setListLoading(true);
    try {
      const { data } = await api.get("/api/attendance/employees", { headers: getAuthHeaders() });
      setEmployees(Array.isArray(data) ? data : []);
    } catch (e) {
      toast.error(e.message || "فشل تحميل الموظفين");
    } finally {
      setListLoading(false);
    }
  }, [toast]);

  useEffect(() => {
    loadEmployees();
  }, [loadEmployees]);

  useEffect(() => {
    if (ready) start().catch(() => {});
    return () => stop();
  }, [ready, start, stop]);

  async function captureSample() {
    if (!selectedId) {
      toast.error("اختر موظفاً أولاً");
      return;
    }
    if (samples.length >= 3) {
      toast.info("تم جمع 3 عينات — احفظ أو أعد التسجيل");
      return;
    }
    setCapturing(true);
    try {
      const desc = await extractDescriptor(videoRef.current);
      if (!desc) {
        toast.error("لم يُكتشف وجه واضح — حاول مرة أخرى");
        return;
      }
      setSamples((prev) => [...prev, desc]);
      toast.success(`تم التقاط العينة ${samples.length + 1} من 3`);
    } catch (e) {
      toast.error(e.message || "فشل التقاط الوجه");
    } finally {
      setCapturing(false);
    }
  }

  function resetSamples() {
    setSamples([]);
  }

  async function saveEnrollment() {
    if (!selectedId) {
      toast.error("اختر موظفاً");
      return;
    }
    if (samples.length < 1) {
      toast.error("التقط عينة وجه واحدة على الأقل");
      return;
    }
    setSaving(true);
    try {
      await api.post(
        "/api/attendance/enroll",
        { user_id: Number(selectedId), descriptors: samples },
        { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
      );
      toast.success("تم حفظ بيانات الوجه");
      resetSamples();
      loadEmployees();
    } catch (e) {
      toast.error(e.message || "فشل حفظ التسجيل");
    } finally {
      setSaving(false);
    }
  }

  async function removeEnrollment(userId) {
    if (!window.confirm("حذف بيانات الوجه لهذا الموظف؟")) return;
    try {
      await api.delete(`/api/attendance/enroll/${userId}`, { headers: getAuthHeaders() });
      toast.success("تم حذف بيانات الوجه");
      loadEmployees();
    } catch (e) {
      toast.error(e.message || "فشل الحذف");
    }
  }

  const selected = employees.find((e) => String(e.id) === String(selectedId));

  const columns = [
    { key: "username", header: "الموظف", value: (r) => r.username },
    {
      key: "role",
      header: "الدور",
      value: (r) => ROLE_LABELS[r.role] || r.role,
    },
    {
      key: "face_enrolled",
      header: "الوجه",
      render: (r) =>
        r.face_enrolled ? (
          <StatusBadge tone="green">مسجّل ({r.face_count})</StatusBadge>
        ) : (
          <StatusBadge tone="amber">غير مسجّل</StatusBadge>
        ),
    },
    {
      key: "actions",
      header: "إجراءات",
      render: (r) =>
        r.face_enrolled ? (
          <SecondaryButton size="sm" type="button" onClick={() => removeEnrollment(r.id)}>
            حذف الوجه
          </SecondaryButton>
        ) : (
          "—"
        ),
    },
  ];

  return (
    <div>
      <Card className="ui-mt-md">
        <CardBody>
          <p className="ui-text-muted" style={{ marginTop: 0 }}>
            سجّل وجه كل موظف (2–3 عينات) ليستخدمه كشك الحضور في المخبز والرفوف.
          </p>

          <FormField label="الموظف">
            <Select value={selectedId} onChange={(e) => setSelectedId(e.target.value)}>
              <option value="">— اختر موظفاً —</option>
              {employees.map((e) => (
                <option key={e.id} value={String(e.id)}>
                  {e.username} ({ROLE_LABELS[e.role] || e.role})
                  {e.face_enrolled ? " ✓" : ""}
                </option>
              ))}
            </Select>
          </FormField>

          {(loading || modelError || cameraError) && (
            <p className="ui-text-muted">
              {loading ? "جاري تحميل نماذج الوجه…" : modelError || cameraError}
            </p>
          )}

          <div
            style={{
              width: "100%",
              maxWidth: 360,
              aspectRatio: "3/4",
              margin: "16px auto",
              borderRadius: 12,
              overflow: "hidden",
              background: "#0f172a",
            }}
          >
            <video
              ref={videoRef}
              playsInline
              muted
              style={{ width: "100%", height: "100%", objectFit: "cover", transform: "scaleX(-1)" }}
            />
          </div>

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center" }}>
            <PrimaryButton
              type="button"
              onClick={captureSample}
              disabled={!ready || !active || capturing || !selectedId}
            >
              {capturing ? "جاري الالتقاط…" : `التقاط عينة (${samples.length}/3)`}
            </PrimaryButton>
            <SecondaryButton type="button" onClick={resetSamples} disabled={!samples.length}>
              إعادة العينات
            </SecondaryButton>
            <PrimaryButton
              type="button"
              onClick={saveEnrollment}
              disabled={saving || !samples.length || !selectedId}
            >
              {saving ? "جاري الحفظ…" : "حفظ الوجه"}
            </PrimaryButton>
          </div>

          {selected ? (
            <p className="ui-text-muted" style={{ textAlign: "center", marginTop: 12 }}>
              التسجيل لـ: <strong>{selected.username}</strong>
            </p>
          ) : null}
        </CardBody>
      </Card>

      <Card className="ui-mt-md">
        <CardBody>
          <h3 style={{ marginTop: 0 }}>حالة التسجيل</h3>
          {listLoading ? (
            <p>جاري التحميل…</p>
          ) : (
            <DataTable columns={columns} rows={employees} keyField="id" />
          )}
        </CardBody>
      </Card>
    </div>
  );
}
