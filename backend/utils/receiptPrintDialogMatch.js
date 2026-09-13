/**
 * Decide whether a Windows Print dialog may be confirmed for one armed POS job.
 * No screen coordinates. No global watcher. One enabled Print invoke.
 */

export const PRINT_DIALOG_NAME_RE = /^(print|طباعة)(\s+dialog)?$/i;
export const PRINT_BUTTON_NAME_RE = /^(print|&print|طباعة)$/i;

export function printerNamesMatch(configured, shown) {
  return String(configured || "").trim() === String(shown || "").trim();
}

export function isPrintDialogName(name) {
  return PRINT_DIALOG_NAME_RE.test(String(name || "").trim());
}

export function isPrintButtonName(name) {
  return PRINT_BUTTON_NAME_RE.test(String(name || "").trim());
}

/**
 * @param {{
 *   armed: boolean,
 *   requestId: string,
 *   dialogRequestId?: string,
 *   printerName: string,
 *   dialogPrinterName: string,
 *   ownerPids: number[],
 *   dialogProcessId: number,
 *   dialogOwnerProcessId?: number,
 *   printButtonEnabled: boolean,
 * }} snap
 */
export function shouldConfirmPrintDialog(snap) {
  if (!snap?.armed) return { confirm: false, reason: "not-armed" };
  if (snap.dialogRequestId && snap.dialogRequestId !== snap.requestId) {
    return { confirm: false, reason: "request-mismatch" };
  }
  if (!isPrintDialogName(snap.dialogName || "Print")) {
    return { confirm: false, reason: "not-print-dialog" };
  }
  const owners = Array.isArray(snap.ownerPids) ? snap.ownerPids.map(Number) : [];
  const pid = Number(snap.dialogProcessId);
  const ownerPid = Number(snap.dialogOwnerProcessId);
  const owned = owners.includes(pid) || (Number.isFinite(ownerPid) && owners.includes(ownerPid));
  if (!owned) return { confirm: false, reason: "owner-mismatch" };
  if (!printerNamesMatch(snap.printerName, snap.dialogPrinterName)) {
    return { confirm: false, reason: "printer-mismatch" };
  }
  if (!snap.printButtonEnabled) return { confirm: false, reason: "print-disabled" };
  return { confirm: true, reason: "ok" };
}
