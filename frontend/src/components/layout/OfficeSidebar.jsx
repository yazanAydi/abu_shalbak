import { useEffect, useRef, useState } from "react";
import { NavLink, useLocation, useNavigate } from "react-router-dom";
import { getUser, removeToken } from "../../utils/auth";
import { ROLE_LABELS_AR } from "../../utils/roles";
import { OFFICE_NAV, NAV_SECTION_LABELS } from "./officeNavConfig";
import Icon from "../icons/Icon";
import "./OfficeLayout.css";

const SECTION_ORDER = ["overview", "catalog", "finance", "operations", "admin"];

function groupNavItems(items) {
  const groups = [];
  let currentSection = null;
  let currentItems = [];

  for (const item of items) {
    const sec = item.section || "other";
    if (sec !== currentSection) {
      if (currentItems.length) {
        groups.push({ section: currentSection, items: currentItems });
      }
      currentSection = sec;
      currentItems = [item];
    } else {
      currentItems.push(item);
    }
  }
  if (currentItems.length) {
    groups.push({ section: currentSection, items: currentItems });
  }

  return groups.sort(
    (a, b) =>
      SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section)
  );
}

export default function OfficeSidebar() {
  const navigate = useNavigate();
  const location = useLocation();
  const user = getUser();
  const role = user?.role || "";
  const items = OFFICE_NAV.filter((item) => item.visible(role));
  const groups = groupNavItems(items);
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
                <span className="office-nav-icon" aria-hidden>
                  <Icon name={item.icon} />
                </span>
                {item.label}
              </NavLink>
            );
          }

          const isOpen = openSection === section;
          const isActive = sectionIsActive(groupItems);
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
                        <span className="office-nav-icon" aria-hidden>
                          <Icon name={item.icon} />
                        </span>
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
        <Icon name={mobileOpen ? "close" : "menu"} size={22} />
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
                      <span className="office-nav-icon" aria-hidden>
                        <Icon name={item.icon} />
                      </span>
                      {item.label}
                    </NavLink>
                  </li>
                ))}
              </ul>
            </div>
          ))}
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
