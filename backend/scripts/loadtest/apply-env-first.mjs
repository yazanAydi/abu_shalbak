/**
 * Side-effect module: apply load-test env before any import that loads auth.js.
 * JWT_SECRET is captured at auth.js module evaluation, so this file must be
 * the first import of runner.mjs and server.mjs.
 */
import { applyLoadtestEnv } from "./guards.mjs";

applyLoadtestEnv();
