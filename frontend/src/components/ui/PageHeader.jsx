import Icon from "../icons/Icon";

export default function PageHeader({ icon, title, subtitle, actions }) {
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
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </div>
  );
}
