import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import api from "../apiClient";
import useAuthUser from "../hooks/useAuthUser";
import { userHasOfficePermission } from "../utils/accountantPermissions";
import { Modal, PrimaryButton, SecondaryButton } from "./ui";

const CHANNEL = "abu-attendance-reminder";

export function attendanceSurfaceBusy() {
  if (typeof document === "undefined") return false;
  const foreignModal = [...document.querySelectorAll(".ui-modal-overlay")].some(
    (el) => !el.querySelector("[data-attendance-reminder]")
  );
  if (foreignModal) return true;
  const active = document.activeElement;
  if (
    active?.closest?.(".office-content") &&
    /^(INPUT|TEXTAREA|SELECT)$/.test(active.tagName)
  ) {
    return true;
  }
  const root = document.querySelector(".office-content");
  if (!root) return false;
  for (const el of root.querySelectorAll("input, textarea")) {
    if (el.disabled || el.readOnly) continue;
    const type = String(el.type || "").toLowerCase();
    if (["hidden", "checkbox", "radio", "button", "submit", "file"].includes(type)) continue;
    if (el.value !== el.defaultValue) return true;
  }
  return false;
}

export function attendancePageHref(businessDay, employees) {
  const ids = (employees || []).map((row) => row.user_id).filter(Boolean).join(",");
  const params = new URLSearchParams();
  if (businessDay) params.set("date", businessDay);
  if (ids) params.set("employees", ids);
  const qs = params.toString();
  return qs ? `/employee-attendance?${qs}` : "/employee-attendance";
}

export default function AttendanceReminder() {
  const user = useAuthUser();
  const navigate = useNavigate();
  const allowed = userHasOfficePermission(user, "employee_payroll");
  const userId = user?.id;
  const [payload, setPayload] = useState(null);
  const [open, setOpen] = useState(false);
  const pending = useRef(null);

  const consider = useCallback((data) => {
    if (!data?.business_day || data.dismissed || !data.employees?.length) {
      pending.current = null;
      setPayload(data || null);
      setOpen(false);
      return;
    }
    pending.current = data;
    setPayload(data);
    if (!attendanceSurfaceBusy()) setOpen(true);
  }, []);

  const refresh = useCallback(async () => {
    if (!allowed || !userId) return;
    if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
    try {
      const { data } = await api.get("/api/attendance/reminder");
      consider(data);
    } catch {
      /* leave the office usable when the check cannot run */
    }
  }, [allowed, userId, consider]);

  useEffect(() => {
    if (!allowed || !userId) return undefined;
    refresh();
    const onResume = () => refresh();
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    const poll = window.setInterval(refresh, 60_000);
    const retry = window.setInterval(() => {
      if (pending.current && !attendanceSurfaceBusy()) setOpen(true);
    }, 1000);
    let channel;
    try {
      channel = new BroadcastChannel(CHANNEL);
      channel.onmessage = (event) => {
        if (Number(event.data?.userId) !== Number(userId)) return;
        const day = event.data?.business_day;
        if (!day || day !== pending.current?.business_day) return;
        pending.current = null;
        setOpen(false);
        setPayload((current) => (current ? { ...current, dismissed: true, employees: [] } : current));
      };
    } catch {
      channel = null;
    }
    return () => {
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
      window.clearInterval(poll);
      window.clearInterval(retry);
      channel?.close();
    };
  }, [allowed, userId, refresh]);

  function publishDismiss(day) {
    try {
      const channel = new BroadcastChannel(CHANNEL);
      channel.postMessage({ userId, business_day: day });
      channel.close();
    } catch {
      /* another tab learns from the next server check */
    }
  }

  async function dismiss() {
    const day = payload?.business_day;
    pending.current = null;
    setOpen(false);
    setPayload((current) => (current ? { ...current, dismissed: true, employees: [] } : current));
    try {
      await api.post("/api/attendance/reminder/dismiss");
      publishDismiss(day);
    } catch {
      pending.current = payload;
      setPayload(payload);
      setOpen(true);
    }
  }

  function recordAttendance() {
    const href = attendancePageHref(payload?.business_day, payload?.employees);
    dismiss();
    navigate(href);
  }

  if (!open || !payload?.employees?.length) return null;

  return (
    <Modal
      open
      className="attendance-reminder"
      title="تسجيل حضور الموظفين"
      description="يوجد موظفون بنظام الساعة لم يتم تسجيل حضورهم لهذا اليوم."
      onClose={dismiss}
      footer={
        <>
          <SecondaryButton type="button" onClick={dismiss}>
            لاحقًا
          </SecondaryButton>
          <PrimaryButton type="button" onClick={recordAttendance}>
            تسجيل الحضور
          </PrimaryButton>
        </>
      }
    >
      <div data-attendance-reminder="">
        <p className="attendance-reminder__day">يوم العمل: {payload.business_day}</p>
        <ul className="attendance-reminder__list">
          {payload.employees.map((row) => (
            <li key={row.user_id}>{row.name}</li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
