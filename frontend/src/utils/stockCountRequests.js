import api from "../apiClient";
import { getAuthHeaders } from "./auth";
import { countProductId } from "./stockCountEntry";

const SOURCE_BATCH_SIZE = 100;

function uniqueProductIds(values) {
  return [...new Set((values || []).map(countProductId).filter(Boolean))];
}

function requireCountPicture(picture, productId) {
  if (!picture || typeof picture !== "object" || Array.isArray(picture)
      || (picture.product_id != null && Number(picture.product_id) !== productId)) {
    throw new Error("تعذّر تحميل بيانات بعض أصناف الجرد. حاول مجدداً.");
  }
  return picture;
}

/** Keep large counts to bounded, sequential requests instead of one per row. */
export async function loadCountPictures(productIds, { signal } = {}) {
  const ids = uniqueProductIds(productIds);
  const pictures = {};
  for (let offset = 0; offset < ids.length; offset += SOURCE_BATCH_SIZE) {
    const chunk = ids.slice(offset, offset + SOURCE_BATCH_SIZE);
    const { data } = await api.post(
      "/api/inventory/stock-sources/batch",
      { product_ids: chunk },
      { headers: getAuthHeaders(), ...(signal ? { signal } : {}) }
    );
    for (const id of chunk) {
      pictures[id] = requireCountPicture(data?.pictures?.[id], id);
    }
  }
  return pictures;
}

/** Per-editor in-flight sharing; no stale source cache survives a completed read. */
export function createCountPictureLoader() {
  const inFlight = new Map();
  const controllers = new Set();
  let disposed = false;

  return {
    async load(productIds) {
      const ids = uniqueProductIds(productIds);
      if (disposed) return {};
      const missing = ids.filter((id) => !inFlight.has(id));
      if (missing.length) {
        const controller = new AbortController();
        controllers.add(controller);
        // Preserve the existing small lookup for a newly selected product.
        const request = missing.length === 1
          ? api.get("/api/inventory/stock-sources", {
              headers: getAuthHeaders(),
              params: { product_id: missing[0] },
              signal: controller.signal,
            }).then(({ data }) => ({ [missing[0]]: requireCountPicture(data, missing[0]) }))
          : loadCountPictures(missing, { signal: controller.signal });
        for (const id of missing) {
          const result = request.then((pictures) => pictures[id]);
          inFlight.set(id, result);
          const cleanup = () => {
            if (inFlight.get(id) === result) inFlight.delete(id);
          };
          result.then(cleanup, cleanup);
        }
        const cleanup = () => controllers.delete(controller);
        request.then(cleanup, cleanup);
      }
      const entries = await Promise.all(ids.map(async (id) => [id, await inFlight.get(id)]));
      return Object.fromEntries(entries);
    },
    dispose() {
      disposed = true;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      inFlight.clear();
    },
  };
}
