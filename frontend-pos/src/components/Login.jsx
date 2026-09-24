import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { setToken, setUser, getUser, removeToken } from "../utils/auth";
import { canLoginPos, homePathForRole, wrongPortalLoginMessage } from "../utils/roles";
import "./Login.css";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  useEffect(() => {
    if (searchParams.get("session") === "expired") {
      setError("انتهت الجلسة أو الرمز غير صالح. سجّل الدخول مرة أخرى.");
      return;
    }
    if (searchParams.get("wrong_portal") === "1") {
      setError("لا يمكن استخدام هذا الحساب في نقطة البيع.");
      return;
    }
    if (searchParams.get("signin") === "1") {
      removeToken();
    }
  }, [searchParams]);

  const canSubmit = username.trim() && password.trim() && !loading;

  async function submit() {
    if (!canSubmit) return;
    setError("");
    setLoading(true);
    try {
      const { data } = await api.post("/api/auth/login", {
        username: username.trim(),
        password,
        app: "pos",
      });
      if (!canLoginPos(data.user?.role)) {
        removeToken();
        setError(wrongPortalLoginMessage(data.user?.role));
        return;
      }
      setToken(data.token);
      setUser(data.user);
      if (data.user?.must_change_password) {
        setMustChange(true);
        setCurrentPassword(password);
        setError("يجب تغيير كلمة المرور قبل المتابعة");
        return;
      }
      navigate(homePathForRole(data.user?.role), { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message || "تعذر تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  }

  async function submitNewPassword() {
    if (loading) return;
    if (newPassword.length < 6) {
      setError("كلمة المرور الجديدة يجب أن تكون 6 أحرف على الأقل");
      return;
    }
    if (newPassword !== confirmPassword) {
      setError("تأكيد كلمة المرور غير مطابق");
      return;
    }
    setError("");
    setLoading(true);
    try {
      const { data } = await api.post("/api/auth/change-password", {
        current_password: currentPassword || password,
        new_password: newPassword,
      });
      if (data?.token) setToken(data.token);
      const nextUser = { ...(getUser() || {}), ...(data?.user || {}), must_change_password: false };
      setUser(nextUser);
      setMustChange(false);
      navigate(homePathForRole(nextUser.role), { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message || "تعذر تغيير كلمة المرور");
    } finally {
      setLoading(false);
    }
  }

  function logoutForced() {
    removeToken();
    setMustChange(false);
    setPassword("");
    setCurrentPassword("");
    setNewPassword("");
    setConfirmPassword("");
    setError("");
  }

  function onKeyDown(ev) {
    if (ev.key === "Enter") {
      if (mustChange) submitNewPassword();
      else submit();
    }
  }

  return (
    <div className="login-page" dir="rtl" lang="ar">
      <section className="login-brand">
        <h1>أبو شلبك</h1>
        <p>نظام إدارة المتجر</p>
        <span className="login-brand-tag">نقطة البيع</span>
      </section>
      <section className="login-panel">
        <div className="login-card" data-enter-nav="off">
          <h2 className="login-card-title">{mustChange ? "تغيير كلمة المرور" : "تسجيل الدخول"}</h2>
          <p className="login-sub">
            {mustChange ? "يجب تغيير كلمة المرور قبل استخدام الصندوق" : "أدخل بيانات الكاشير للمتابعة"}
          </p>
          {mustChange ? (
            <>
              <label className="login-label">
                كلمة المرور الحالية
                <input
                  type="password"
                  className="login-input"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="current-password"
                  disabled={loading}
                />
              </label>
              <label className="login-label">
                كلمة المرور الجديدة
                <input
                  type="password"
                  className="login-input"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="new-password"
                  disabled={loading}
                />
              </label>
              <label className="login-label">
                تأكيد كلمة المرور
                <input
                  type="password"
                  className="login-input"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyDown={onKeyDown}
                  autoComplete="new-password"
                  disabled={loading}
                />
              </label>
              {error ? <div className="login-error">{error}</div> : null}
              <button
                type="button"
                className="login-btn"
                disabled={loading || !newPassword || !confirmPassword}
                onClick={() => void submitNewPassword()}
              >
                {loading ? "جاري الحفظ..." : "حفظ كلمة المرور"}
              </button>
              <button type="button" className="login-btn" style={{ marginTop: 8 }} onClick={logoutForced}>
                تسجيل الخروج
              </button>
            </>
          ) : (
            <>
          <label className="login-label">
            اسم المستخدم
            <input
              className="login-input"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="username"
              disabled={loading}
            />
          </label>
          <label className="login-label">
            كلمة المرور
            <input
              type="password"
              className="login-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={onKeyDown}
              autoComplete="current-password"
              disabled={loading}
            />
          </label>
          {error ? <div className="login-error">{error}</div> : null}
          <button
            type="button"
            className="login-btn"
            disabled={!canSubmit}
            onClick={submit}
          >
            {loading ? "جاري الدخول..." : "دخول"}
          </button>
            </>
          )}
        </div>
      </section>
    </div>
  );
}
