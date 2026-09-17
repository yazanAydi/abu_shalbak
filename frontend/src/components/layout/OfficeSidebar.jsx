import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { removeToken } from "../../utils/auth";
import useAuthUser from "../../hooks/useAuthUser";
import { ROLE_LABELS_AR } from "../../utils/roles";
import { filterOfficeNav, groupOfficeNav, NAV_SECTION_LABELS } from "./officeNavConfig";
import useOfficeNavBadges, { navItemBadgeCount, sumSectionBadgeCount } from "../../hooks/useOfficeNavBadges";
import NavBadge from "./NavBadge";
import NavIconWithBadge from "./NavIconWithBadge";
import Icon from "../icons/Icon";
import { usePageRefresh } from "./PageRefreshContext";
import "./OfficeLayout.css";

export default function OfficeSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = useAuthUser();
  const role = user?.role || "";
  const permissions = user?.permissions ?? null;
  const items = filterOfficeNav(role, permissions);
  const groups = groupOfficeNav(items);
  const { badgesByPath, total } = useOfficeNavBadges(Boolean(role));
  const { refreshPage, refreshing } = usePageRefresh();
  const initial = (user?.username || "?").charAt(0).toUpperCase();

  const [openSection, setOpenSection] = useState(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const navRef = useRef(null);
  const navbarRef = useRef(null);

  useEffect(() => {
    function handleOutside(event) {
      if (navRef.current && !navRef.current.contains(event.target)) {
        setOpenSection(null);
      }
      if (
        mobileOpen &&
        navbarRef.current &&
        !navbarRef.current.contains(event.target)
      ) {
        setMobileOpen(false);
      }
    }
    document.addEventListener("mousedown", handleOutside);
    return () => document.removeEventListener("mousedown", handleOutside);
  }, [mobileOpen]);

  useEffect(() => {
    setOpenSection(null);
    setMobileOpen(false);
  }, [location.pathname]);

  function logout() {
    removeToken();
    navigate("/login", { replace: true });
  }

  function sectionIsActive(groupItems) {
    return groupItems.some(
      (item) =>
        location.pathname === item.path ||
        location.pathname.startsWith(`${item.path}/`)
    );
  }

  return (
    <header className="office-navbar" dir="rtl" lang="ar" ref={navbarRef}>
      <div className="office-navbar-brand">
        <div className="office-navbar-brand-logo" aria-hidden>
          أ
        </div>
        <div className="office-navbar-brand-text">
          <h1>أبو شلبك</h1>
          <p>لوحة الإدارة</p>
        </div>
      </div>

      <nav
        ref={navRef}
        aria-label="التنقل الرئيسي"
        className="office-navbar-nav"
      >
        {groups.map(({ section, items: groupItems }) => {
          if (groupItems.length === 1) {
            const item = groupItems[0];
            return (
              <NavLink
                key={section}
                to={item.path}
                className={({ isActive }) =>
                  isActive ? "office-nav-link active" : "office-nav-link"
                }
                end={item.path === "/reports"}
              >
                <NavIconWithBadge
                  name={item.icon}
                  count={navItemBadgeCount(item, badgesByPath)}
                />
                {item.label}
              </NavLink>
            );
          }

          const isOpen = openSection === section;
          const isActive = sectionIsActive(groupItems);
          const sectionBadge = sumSectionBadgeCount(groupItems, badgesByPath);
          return (
            <div key={section} className="office-nav-dropdown">
              <button
                type="button"
                className={`office-nav-link office-nav-trigger${
                  isActive ? " active" : ""
                }${isOpen ? " open" : ""}`}
                aria-expanded={isOpen}
                onClick={() =>
                  setOpenSection((prev) => (prev === section ? null : section))
                }
              >
                {NAV_SECTION_LABELS[section] || section}
                <NavBadge count={sectionBadge} />
                <span className="office-nav-chevron" aria-hidden>
                  <Icon name="chevronDown" size={18} />
                </span>
              </button>
              {isOpen ? (
                <ul className="office-nav-dropdown-menu">
                  {groupItems.map((item) => (
                    <li key={item.path}>
                      <NavLink
                        to={item.path}
                        className={({ isActive: linkActive }) =>
                          linkActive
                            ? "office-nav-dropdown-item active"
                            : "office-nav-dropdown-item"
                        }
                      >
                        <NavIconWithBadge
                          name={item.icon}
                          count={navItemBadgeCount(item, badgesByPath)}
                        />
                        {item.label}
                      </NavLink>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          );
        })}
      </nav>

      <div className="office-navbar-user">
        <button
          type="button"
          className={`office-navbar-refresh${refreshing ? " is-refreshing" : ""}`}
          onClick={refreshPage}
          disabled={refreshing || typeof refreshPage !== "function"}
          aria-label="تحديث الصفحة"
          title="تحديث"
        >
          <Icon name="refresh" size={18} />
          <span className="office-navbar-refresh-label">تحديث</span>
        </button>
        <div className="office-navbar-avatar" aria-hidden>
          {initial}
        </div>
        <div className="office-navbar-user-info">
          <div className="office-navbar-user-name">{user?.username || "—"}</div>
          <div className="office-navbar-user-role">
            {ROLE_LABELS_AR[role] || role || "—"}
          </div>
        </div>
        <button
          type="button"
          className="office-navbar-logout"
          onClick={logout}
        >
          خروج
        </button>
      </div>

      <button
        type="button"
        className="office-navbar-toggle"
        aria-label="القائمة"
        aria-expanded={mobileOpen}
        onClick={() => setMobileOpen((prev) => !prev)}
      >
        <span className="office-nav-icon-wrap">
          <span className="office-nav-icon" aria-hidden>
            <Icon name={mobileOpen ? "close" : "menu"} size={22} />
          </span>
          {!mobileOpen ? <NavBadge count={total} /> : null}
        </span>
      </button>

      {mobileOpen ? (
        <div className="office-navbar-mobile-panel">
          {groups.map(({ section, items: groupItems }) => (
            <div key={section} className="office-navbar-mobile-group">
              {NAV_SECTION_LABELS[section] ? (
                <div className="office-navbar-mobile-label">
                  {NAV_SECTION_LABELS[section]}
                </div>
              ) : null}
              <ul>
                {groupItems.map((item) => (
                  <li key={item.path}>
                    <NavLink
                      to={item.path}
                      className={({ isActive }) =>
                        isActive
                          ? "office-navbar-mobile-link active"
                          : "office-navbar-mobile-link"
                      }
                      end={item.path === "/reports"}
                    >
                      <NavIconWithBadge
                        name={item.icon}
                        count={navItemBadgeCount(item, badgesByPath)}
                      />
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
          <button
            type="button"
            className={`office-navbar-mobile-refresh${refreshing ? " is-refreshing" : ""}`}
            onClick={() => {
              if (typeof refreshPage === "function") refreshPage();
              setMobileOpen(false);
            }}
            disabled={refreshing || typeof refreshPage !== "function"}
          >
            تحديث الصفحة
          </button>
          <button
            type="button"
            className="office-navbar-mobile-logout"
            onClick={logout}
          >
            خروج
          </button>
        </div>
      ) : null}
    </header>
  );
}
