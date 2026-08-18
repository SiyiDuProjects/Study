import { Router, type RequestHandler } from "express";

import { safeEqualText } from "../crypto/secrets.js";
import { CourseCatalogError, type CourseCatalogService } from "../course/index.js";

function requireServiceToken(expectedToken: string): RequestHandler {
  return (request, response, next) => {
    const authorization = request.get("authorization") ?? "";
    const prefix = "Bearer ";
    const supplied = authorization.startsWith(prefix) ? authorization.slice(prefix.length) : "";
    if (!supplied || !safeEqualText(supplied, expectedToken)) {
      response.set("WWW-Authenticate", 'Bearer realm="study-internal"');
      response.status(401).json({ error: "unauthorized" });
      return;
    }
    next();
  };
}

export function createInternalRouter(
  courseCatalog: CourseCatalogService,
  studyServiceToken: string,
): Router {
  const router = Router();
  router.use("/internal", requireServiceToken(studyServiceToken));
  router.use("/internal", (_request, response, next) => {
    response.set("Cache-Control", "no-store");
    next();
  });

  router.get("/internal/lecture/courses", async (_request, response) => {
    try {
      response.json(await courseCatalog.listForLecture(true));
    } catch (error) {
      if (error instanceof CourseCatalogError) {
        response.status(error.status).json({ error: error.code });
        return;
      }
      response.status(500).json({ error: "internal_error" });
    }
  });

  return router;
}
