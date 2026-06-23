import { getAdminLoginUrl } from "../utils/appLinks";

export default function OfficeLink({ className, children = "لوحة الإدارة" }) {
  return (
    <a href={getAdminLoginUrl()} className={className}>
      {children}
    </a>
  );
}
