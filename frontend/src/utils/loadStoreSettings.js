import api from "../apiClient";
import { getAuthHeaders } from "./auth";

/**
 * Load store settings for print branding. Falls back to {} so hardcoded defaults apply.
 */
export async function loadStoreSettings() {
  try {
    const { data } = await api.get("/api/settings", { headers: getAuthHeaders() });
    return data || {};
  } catch {
    return {};
  }
}
