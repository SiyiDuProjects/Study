import { CanvasApiError } from "./errors.js";

const CHATGPT_ORIGIN = "https://chatgpt.com";
const GENERATED_FILE_PATH = "/backend-api/estuary/content";
const reject = (message: string): never => { throw new CanvasApiError("invalid_argument", message); };

/** Validate the client file reference without logging or persisting its signed URL. */
export function chatGptFileSource(raw: string, fileId: string, allowedOrigins: readonly string[]): URL {
  let url: URL;
  try { url = new URL(raw); }
  catch { return reject("ChatGPT must hand off a valid HTTPS file download reference."); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    return reject("ChatGPT must hand off an HTTPS file download reference, not a local path or credential-bearing URL.");
  }
  // Generated conversation files use this signed endpoint instead of a CDN origin.
  // Keep the exception narrower than an origin allowlist, even if an operator adds chatgpt.com.
  if (url.origin === CHATGPT_ORIGIN) {
    if (url.pathname !== GENERATED_FILE_PATH ||
      url.searchParams.getAll("id").length !== 1 || url.searchParams.get("id") !== fileId ||
      url.searchParams.getAll("sig").length !== 1 || !url.searchParams.get("sig")?.trim()) {
      return reject("ChatGPT generated files require the signed file-content endpoint bound to the selected file. Rejected before any LMS upload.");
    }
    return url;
  }
  if (!allowedOrigins.includes(url.origin)) {
    return reject(`ChatGPT file source origin is not enabled: ${url.origin}. Rejected before any LMS upload.`);
  }
  return url;
}
