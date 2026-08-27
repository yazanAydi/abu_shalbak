import { useEffect, useState } from "react";

/**
 * Tracks a CSS media query from JS so a component can skip rendering — and skip
 * the requests behind it — for parts of the UI the stylesheet hides at this
 * width. Without this, a phone still mounts and polls desktop-only chrome.
 *
 * @param {string} query — e.g. "(min-width: 1101px)"
 * @returns {boolean}
 */
export function useMediaQuery(query) {
  const supported =
    typeof window !== "undefined" && typeof window.matchMedia === "function";

  const [matches, setMatches] = useState(() =>
    supported ? window.matchMedia(query).matches : false
  );

  useEffect(() => {
    if (!supported) return undefined;
    const list = window.matchMedia(query);
    const onChange = (event) => setMatches(event.matches);
    setMatches(list.matches);
    list.addEventListener("change", onChange);
    return () => list.removeEventListener("change", onChange);
  }, [query, supported]);

  return matches;
}

export default useMediaQuery;
