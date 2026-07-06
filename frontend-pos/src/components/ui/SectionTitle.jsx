/**
 * Consistent section heading inside cards and page sections.
 */
export default function SectionTitle({ children, as: Tag = "h2", className = "", ...rest }) {
  return (
    <Tag className={`dashboard-section-title ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}
