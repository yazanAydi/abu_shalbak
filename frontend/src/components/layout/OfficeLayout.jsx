import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import api from "../../apiClient";
import { getToken, setUser } from "../../utils/auth";
import OfficeSidebar from "./OfficeSidebar";
import OfficeSideRail from "./OfficeSideRail";
import { PageRefreshProvider, usePageRefresh } from "./PageRefreshContext";
import "../../styles/office-theme.css";
import "./OfficeLayout.css";

function OfficePageOutlet() {
  const { pageKey } = usePageRefresh();
  return <Outlet key={pageKey} />;
}

export default function OfficeLayout() {
  useEffect(() => {
    let cancelled = false;

    async function refreshMe() {
      if (typeof document !== "undefined" && document.visibilityState === "hidden") return;
      const token = getToken();
      if (!token) return;
      try {
        const { data } = await api.get("/api/auth/me");
        if (!cancelled && data?.user) setUser(data.user);
      } catch {
        /* keep cached user; API remains authoritative */
      }
    }

    function onResume() {
      refreshMe();
    }

    refreshMe();
    window.addEventListener("focus", onResume);
    document.addEventListener("visibilitychange", onResume);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onResume);
      document.removeEventListener("visibilitychange", onResume);
    };
  }, []);

  return (
    <PageRefreshProvider>
      <div className="office-shell" dir="rtl" lang="ar">
        <OfficeSidebar />
        <div className="office-body">
          <main className="office-content">
            <OfficePageOutlet />
          </main>
          <OfficeSideRail />
        </div>
      </div>
    </PageRefreshProvider>
  );
}
