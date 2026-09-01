function isFocusedNumberInput(el) {
  return (
    el instanceof HTMLInputElement &&
    el.type === "number" &&
    document.activeElement === el
  );
}

function onWheel(e) {
  if (isFocusedNumberInput(e.target)) e.preventDefault();
}

function onKeyDown(e) {
  if (!isFocusedNumberInput(e.target)) return;
  if (e.key === "ArrowUp" || e.key === "ArrowDown") e.preventDefault();
}

document.addEventListener("wheel", onWheel, { passive: false });
document.addEventListener("keydown", onKeyDown);
