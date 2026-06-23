import { Outlet } from "react-router-dom";
import OfficeSidebar from "./OfficeSidebar";
import OfficeSideRail from "./OfficeSideRail";
import "../../styles/office-theme.css";
import "./OfficeLayout.css";

export default function OfficeLayout() {
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
