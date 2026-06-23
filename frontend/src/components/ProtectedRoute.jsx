import { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import api from "../apiClient";
import { getToken, getUser, removeToken, setUser } from "../utils/auth";
import {
  canLoginOffice,
  canViewReports,
  homePathForRole,
  isAdminRole,
} from "../utils/roles";
import "./ProtectedRoute.css";

/**
 * Guards routes in the admin (office) app — only admin and accountant may proceed.
 */
export default function ProtectedRoute({
  children,
  adminOnly = false,
  requireReports = false,
  requireOffice = false,
}) {
  const [ready, setReady] = useState(false);
  const [ok, setOk] = useState(false);
  const [user, setUserState] = useState(null);
  const [wrongPortal, setWrongPortal] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function verify() {
      const token = getToken();
      if (!token) {
        if (!cancelled) {
          setOk(false);
          setReady(true);
        }
        return;
      }

      try {
        const { data } = await api.get("/api/auth/me");
        if (cancelled) return;
        if (requireOffice && !canLoginOffice(data.user?.role)) {
          removeToken();
          setWrongPortal(true);
          setReady(true);
          return;
        }
        setUser(data.user);
        setUserState(data.user);
        setOk(true);
      } catch {
        if (cancelled) return;
        removeToken();
        setOk(false);
      } finally {
        if (!cancelled) setReady(true);
      }
    }

    verify();
    return () => {
      cancelled = true;
    };
  }, [requireOffice]);

  if (!ready) {
    return (
      <div className="pr-loading">
        <div className="pr-spinner" aria-label="جاري التحميل" />
      </div>
    );
  }

  if (wrongPortal) {
    return <Navigate to="/login?wrong_portal=1" replace />;
  }

  if (!ok) {
    return <Navigate to="/login" replace />;
  }

  const role = user?.role ?? getUser()?.role;

  if (adminOnly && !isAdminRole(role)) {
    return <Navigate to={homePathForRole(role)} replace />;
  }

  if (requireReports && !canViewReports(role)) {
    return <Navigate to={homePathForRole(role)} replace />;
  }

  return children;
}
