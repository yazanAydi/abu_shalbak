import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import api from "../apiClient";
import { setToken, setUser, removeToken } from "../utils/auth";
import { canLoginPos, homePathForRole, wrongPortalLoginMessage } from "../utils/roles";
import { getAdminLoginUrl } from "../utils/appLinks";
import "./Login.css";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
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
      navigate(homePathForRole(data.user?.role), { replace: true });
    } catch (e) {
      setError(e.response?.data?.error || e.message || "تعذر تسجيل الدخول");
    } finally {
      setLoading(false);
    }
  }

  function onKeyDown(ev) {
    if (ev.key === "Enter") submit();
  }

  return (
    <div className="login-page" dir="rtl" lang="ar">
      <section className="login-brand">
        <h1>أبو شلبك</h1>
        <p>نظام إدارة المتجر</p>
        <span className="login-brand-tag">نقطة البيع</span>
      </section>
      <section className="login-panel">
        <div className="login-card">
          <h2 className="login-card-title">تسجيل الدخول</h2>
          <p className="login-sub">أدخل بيانات الكاشير للمتابعة</p>
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
          <p className="login-hint">
            محاسب أو مدير؟{" "}
            <a href={getAdminLoginUrl()} className="login-pos-link">
              افتح لوحة الإدارة
            </a>
          </p>
        </div>
      </section>
    </div>
  );
}
