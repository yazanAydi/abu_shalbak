import Icon from "../icons/Icon";
import { Input } from "./Field";

export default function SearchInput({
  value,
  onChange,
  placeholder = "بحث…",
  className = "",
  ...rest
}) {
  return (
    <div className={`ui-search ${className}`.trim()}>
      <Icon name="search" />
      <Input
        type="search"
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        {...rest}
      />
    </div>
  );
}
