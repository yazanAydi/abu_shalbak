import { getPosLoginUrl } from "../utils/appLinks";

/**
 * External link to the POS terminal (separate app).
 */
export default function PosLink({ className, children = "نقطة البيع" }) {
  return (
    <a href={getPosLoginUrl()} className={className}>
      {children}
    </a>
  );
}
