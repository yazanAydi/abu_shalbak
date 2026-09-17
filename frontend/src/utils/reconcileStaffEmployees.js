import api from "../apiClient";

/**
 * Idempotent staff-login backfill. Safe to call from office pages; 403 is ignored
 * when the signed-in user cannot manage accounts.
 */
export async function reconcileStaffEmployees() {
  try {
    const { data } = await api.post("/api/admin/users/reconcile-employees", {});
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}
