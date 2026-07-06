export function Card({ children, className = "", ...rest }) {
  return (
    <div className={`ui-card ${className}`} {...rest}>
      {children}
    </div>
  );
}

export function CardHeader({ title, subtitle, actions }) {
  return (
    <div className="ui-card__header">
      <div>
        {title && <h3 className="ui-card__title">{title}</h3>}
        {subtitle && <p className="ui-card__subtitle">{subtitle}</p>}
      </div>
      {actions && <div className="ui-page-header__actions">{actions}</div>}
    </div>
  );
}

export function CardBody({ children, flush, className = "" }) {
  return (
    <div className={`ui-card__body ${flush ? "ui-card__body--flush" : ""} ${className}`}>
      {children}
    </div>
  );
}

export default Card;
