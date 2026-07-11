import Icon from "../icons/Icon";
import NavBadge from "./NavBadge";

/** Nav icon with WhatsApp-style notification pill overlaid on the corner. */
export default function NavIconWithBadge({ name, count, size }) {
  return (
    <span className="office-nav-icon-wrap">
      <span className="office-nav-icon" aria-hidden>
        <Icon name={name} size={size} />
      </span>
      <NavBadge count={count} />
    </span>
  );
}
