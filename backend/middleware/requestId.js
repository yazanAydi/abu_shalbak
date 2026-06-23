import { randomUUID } from "crypto";

export function requestIdMiddleware(req, res, next) {
  const id = req.headers["x-request-id"] || randomUUID();
  req.requestId = id;
  res.setHeader("X-Request-Id", id);
  next();
}
