/**
 * Wrap JSON responses in consistent API envelope for /api/v1 routes.
 */
export function responseEnvelope(req, res, next) {
  const origJson = res.json.bind(res);
  res.json = (body) => {
    if (res.statusCode >= 400) {
      const payload =
        body && typeof body === "object"
          ? { success: false, ...body }
          : { success: false, error: String(body ?? "خطأ") };
      return origJson({ ...payload, requestId: req.requestId });
    }
    if (body && typeof body === "object" && body.success === false) {
      return origJson({ ...body, requestId: req.requestId });
    }
    if (body && typeof body === "object" && body.success === true && "data" in body) {
      return origJson({ ...body, meta: { ...(body.meta || {}), requestId: req.requestId } });
    }
    return origJson({
      success: true,
      data: body,
      meta: { requestId: req.requestId },
    });
  };
  next();
}
