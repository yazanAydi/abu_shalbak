import { useContext } from "react";
import Icon from "../icons/Icon";
import PageRefreshButton from "./PageRefreshButton";
import { PageRefreshContext } from "../layout/PageRefreshContext";

export default function PageHeader({
  icon,
  title,
  subtitle,
  actions,
  onRefresh,
  refresh = true,
  refreshing = false,
  refreshDisabled = false,
}) {
  const ctx = useContext(PageRefreshContext);
  const handleRefresh = onRefresh || ctx?.refreshPage;
  const isRefreshing = Boolean(refreshing || ctx?.refreshing);
  const showRefresh = refresh !== false && typeof handleRefresh === "function";

  return (
    <div className="ui-page-header">
      <div className="ui-page-header__titles">
        {icon && (
          <div className="ui-page-header__icon" aria-hidden>
            <Icon name={icon} size={22} />
          </div>
        )}
        <div>
          <h1>{title}</h1>
          {subtitle && <p className="ui-page-header__subtitle">{subtitle}</p>}
        </div>
      </div>
      {(actions || showRefresh) && (
        <div className="ui-page-header__actions">
          {actions}
          {showRefresh ? (
            <PageRefreshButton
              onClick={handleRefresh}
              refreshing={isRefreshing}
              disabled={refreshDisabled}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
