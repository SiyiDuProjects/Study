import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createConfiguredBrowserAuthenticator,
  type BrowserAuthenticator
} from "./auth.js";
import { createServerApp } from "./app.js";
import { openDatabase } from "./db.js";
import { createStudyCourseClient } from "./study.js";
import { lectureListenHost } from "./network.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const production = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT ?? 3001);
const staticDir = process.env.LECTURE_STATIC_DIR ?? process.env.JIAHUAN_STATIC_DIR ?? path.resolve(__dirname, "../../dist");

const studyApiUrl = requiredConfiguration("STUDY_API_URL");
const studyServiceToken = requiredConfiguration("STUDY_SERVICE_TOKEN");
const lectureServiceToken = requiredConfiguration("LECTURE_SERVICE_TOKEN");
const publicOrigin = production ? requiredConfiguration("LECTURE_PUBLIC_ORIGIN") : process.env.LECTURE_PUBLIC_ORIGIN;
if (production) {
  validateProductionEndpoints(studyApiUrl, publicOrigin!);
  requiredConfiguration("OPENAI_API_KEY");
}
const authenticateBrowser = loadBrowserAuthenticator();

const db = openDatabase();
const studyClient = createStudyCourseClient({ baseUrl: studyApiUrl, serviceToken: studyServiceToken });
const app = createServerApp({
  db,
  studyClient,
  authenticateBrowser,
  lectureServiceToken,
  internalAllowedHosts: production ? ["jiahuan_web:3000"] : ["localhost", "127.0.0.1"],
  publicOrigin,
  staticDir
});

app.listen(port, lectureListenHost(production), () => {
  console.log(`Study Lecture listening on ${port}`);
});

function loadBrowserAuthenticator(): BrowserAuthenticator {
  return createConfiguredBrowserAuthenticator({
    production,
    authMode: process.env.LECTURE_AUTH_MODE,
    teamDomain: process.env.CF_ACCESS_TEAM_DOMAIN,
    audience: process.env.CF_ACCESS_AUD,
    ownerEmail: process.env.LECTURE_OWNER_EMAIL
  });
}

function requiredConfiguration(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function validateProductionEndpoints(studyApiUrl: string, publicOrigin: string): void {
  const study = new URL(studyApiUrl);
  if (study.protocol !== "http:" || study.hostname !== "canvas" || study.port !== "8794" || study.pathname !== "/") {
    throw new Error("Production STUDY_API_URL must be exactly http://canvas:8794");
  }
  const lecture = new URL(publicOrigin);
  if (lecture.protocol !== "https:" || lecture.hostname !== "lecture.siyidu.com" || lecture.pathname !== "/") {
    throw new Error("Production LECTURE_PUBLIC_ORIGIN must be exactly https://lecture.siyidu.com");
  }
}
