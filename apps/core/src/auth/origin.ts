import type { Request } from "express";
import type { AppConfig } from "../config.js";
import { AuthError } from "./errors.js";

export function assertSameOriginBrowserPost(
  request: Pick<Request, "method" | "headers">,
  config: Pick<AppConfig, "publicOrigin">,
): void {
  if (request.method.toUpperCase() !== "POST") {
    throw new AuthError("method_not_allowed", "Browser state changes must use POST", 405);
  }
  const origin = request.headers.origin;
  if (typeof origin !== "string" || origin !== config.publicOrigin) {
    throw new AuthError("invalid_origin", "The request Origin does not match this service", 403);
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (typeof fetchSite === "string" && fetchSite !== "same-origin") {
    throw new AuthError("invalid_origin", "Cross-site browser POST requests are not allowed", 403);
  }
}
