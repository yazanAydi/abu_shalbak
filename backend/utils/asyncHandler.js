import { Router } from "express";

/** Wrap an async Express handler so rejected promises reach `next(err)`. */
export function asyncHandler(fn) {
  return (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

function wrapArg(arg) {
  if (typeof arg === "function" && arg.constructor.name === "AsyncFunction") {
    return asyncHandler(arg);
  }
  return arg;
}

/** Express router that auto-wraps async route handlers. */
export function createSafeRouter(...args) {
  const router = Router(...args);
  for (const method of ["get", "post", "put", "patch", "delete", "all"]) {
    const orig = router[method].bind(router);
    router[method] = (...routeArgs) => orig(...routeArgs.map(wrapArg));
  }
  return router;
}
