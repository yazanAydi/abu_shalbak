import { useEffect } from "react";
import { Outlet } from "react-router-dom";
import api from "../../apiClient";
import { getToken, setUser } from "../../utils/auth";
import {
  SCANNER_RESERVED_KEY_EVENT,
  SCANNER_RESERVED_KEY_HINT_AR,
} from "../../utils/blockDevToolsShortcuts";
import { useToast } from "../ui/Toast";
import OfficeSidebar from "./OfficeSidebar";
import OfficeSideRail from "./OfficeSideRail";
import "../../styles/office-theme.css";
import "./OfficeLayout.css";

export default function OfficeLayout() {
  const toast = useToast();

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

  useEffect(() => {
    let shown = false;
    function onReservedKey() {
      if (shown) return;
      shown = true;
      toast.info(SCANNER_RESERVED_KEY_HINT_AR, 12000);
    }
    window.addEventListener(SCANNER_RESERVED_KEY_EVENT, onReservedKey);
    return () => window.removeEventListener(SCANNER_RESERVED_KEY_EVENT, onReservedKey);
  }, [toast]);

  return (
    <div className="office-shell" dir="rtl" lang="ar">
      <OfficeSidebar />
      <div className="office-body">
        <main className="office-content">
          <Outlet />
        </main>
        <OfficeSideRail />
      </div>
    </div>
  );
}
