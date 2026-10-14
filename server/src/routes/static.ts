/**
 * The SPA fallback: everything that is not an API route is the app shell.
 *
 * Registered last, after the API mount and its catch-all, so a request that
 * matches neither reaches the shell rather than the shell swallowing an API
 * path the way registering this earlier would.
 */

import type { Hono } from "hono";
import { config } from "../config.js";
import { staticHandler } from "../static.js";
import type { Env } from "./shared.js";

export function registerStaticRoutes(app: Hono<Env>, basePath: string): void {
  // ---------- Static SPA ----------
  app.get("*", staticHandler(config.staticDir, basePath));
}
