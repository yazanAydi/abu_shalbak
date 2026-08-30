import { createHash } from "node:crypto";

/**
 * Send JSON with ETag / Cache-Control so LAN and Tailscale clients can 304.
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {unknown} body
 * @param {{ maxAgeSec?: number }} [opts]
 */
export function sendCachedJson(req, res, body, { maxAgeSec = 30 } = {}) {
  const etag = `"${createHash("sha1").update(JSON.stringify(body)).digest("hex")}"`;
  res.setHeader("ETag", etag);
  res.setHeader("Cache-Control", `private, max-age=${maxAgeSec}`);
  if (req.headers["if-none-match"] === etag) {
    return res.status(304).end();
  }
  return res.json(body);
}
