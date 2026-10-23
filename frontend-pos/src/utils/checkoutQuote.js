import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { cartItemsToSuspendPayload } from "./suspendedCart";

export async function fetchCheckoutQuote({ cartItems, suspendedSaleId }) {
  const { data } = await api.post(
    "/api/checkout/quote",
    {
      items: cartItemsToSuspendPayload(cartItems),
      suspended_sale_id: suspendedSaleId || null,
    },
    { headers: { ...getAuthHeaders(), "Content-Type": "application/json" } }
  );
  return data;
}
