import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import api from "../../apiClient";
import { getAuthHeaders } from "../../utils/auth";
import { usePosWindowClosePrompt } from "../../hooks/usePosWindowClosePrompt";
import PosLeaveChoiceModal from "./PosLeaveChoiceModal";

const ShiftEnd = lazy(() => import("../ShiftEnd"));

/**
 * Asks the cashier to log out or end the shift when they try to close the POS window.
 * Pass shiftId from checkout, or autoLoad on pages that do not already know the shift.
 * @param {object} props
 * @param {number | null} [props.shiftId]
 * @param {number} [props.suspendedCount]
 * @param {boolean} [props.cartDirty]
 * @param {boolean} [props.autoLoad]
 * @param {boolean} [props.open]
 * @param {() => void} [props.onOpen]
 * @param {() => void} [props.onCancel]
 * @param {() => void} props.onLogout
 * @param {() => void} [props.onEndShift]
 */
export default function PosWindowCloseHost({
  shiftId = null,
  suspendedCount = 0,
  cartDirty = false,
  autoLoad = false,
  open,
  onOpen,
  onCancel,
  onLogout,
  onEndShift,
}) {
  const [loadedShiftId, setLoadedShiftId] = useState(null);
  const [loadedSuspended, setLoadedSuspended] = useState(0);
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const [endOpen, setEndOpen] = useState(false);
  const controlled = open !== undefined;
  const isOpen = controlled ? open : uncontrolledOpen;
  const effectiveShiftId = autoLoad ? loadedShiftId : shiftId;
  const effectiveSuspended = autoLoad ? loadedSuspended : suspendedCount;

  useEffect(() => {
    if (!autoLoad) return undefined;
    let cancelled = false;
    api
      .get("/api/shifts/current", { headers: getAuthHeaders() })
      .then(({ data }) => {
        if (cancelled) return;
        setLoadedShiftId(data?.shift?.id ?? null);
        setLoadedSuspended(Number(data?.suspended_sales_count) || 0);
      })
      .catch(() => {
        if (!cancelled) setLoadedShiftId(null);
      });
    return () => {
      cancelled = true;
    };
  }, [autoLoad]);

  useEffect(() => {
    if (effectiveShiftId) return;
    if (!controlled) setUncontrolledOpen(false);
  }, [controlled, effectiveShiftId]);

  const showChoice = useCallback(() => {
    if (controlled) onOpen?.();
    else setUncontrolledOpen(true);
  }, [controlled, onOpen]);

  const hideChoice = useCallback(() => {
    if (controlled) onCancel?.();
    else setUncontrolledOpen(false);
  }, [controlled, onCancel]);

  usePosWindowClosePrompt(Boolean(effectiveShiftId), showChoice);

  function chooseLogout() {
    hideChoice();
    onLogout();
  }

  function chooseEndShift() {
    hideChoice();
    if (onEndShift) onEndShift();
    else setEndOpen(true);
  }

  return (
    <>
      <PosLeaveChoiceModal
        open={Boolean(isOpen && effectiveShiftId)}
        cartDirty={cartDirty}
        onLogout={chooseLogout}
        onEndShift={chooseEndShift}
        onCancel={hideChoice}
      />
      {!onEndShift && endOpen && effectiveShiftId ? (
        <Suspense fallback={null}>
          <ShiftEnd
            shiftId={effectiveShiftId}
            suspendedCount={effectiveSuspended}
            open
            onClose={() => setEndOpen(false)}
            onSuccess={onLogout}
          />
        </Suspense>
      ) : null}
    </>
  );
}
