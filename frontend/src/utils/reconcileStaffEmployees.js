import api from "../apiClient";
import { getAuthHeaders } from "./auth";

/**
 * Read-only review of staff logins and employee records.
 * Does not create or link anyone.
 */
export async function reviewStaffEmployeeLinks() {
  const { data } = await api.get("/api/admin/users/employee-link-review", {
    headers: getAuthHeaders(),
  });
  return data && typeof data === "object" ? data : null;
}
