import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type Node = DefaultTreeAdapterMap["node"];

const allowedTags = new Set([
  "a", "p", "br", "div", "span", "strong", "b", "em", "i", "u", "s", "code", "pre",
  "blockquote", "ul", "ol", "li", "table", "thead", "tbody", "tr", "th", "td",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr", "sub", "sup",
]);
const excludedTags = new Set([
  "script", "style", "iframe", "object", "embed", "form", "input", "button", "textarea",
  "select", "option", "template", "svg", "math", "noscript", "meta", "base", "link",
]);
const blockTags = new Set([
  "p", "br", "div", "pre", "blockquote", "ul", "ol", "li", "table", "tr",
  "h1", "h2", "h3", "h4", "h5", "h6", "hr",
]);

function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const resourceParameters = new Set(["id", "page", "course_id", "assignment_id", "file_id", "module_item_id", "discussion_topic_id"]);

/** Only bounded numeric resource locators survive; capability queries never do. */
export function safePublicUrl(value: unknown, baseUrl?: string): string | null {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u0020\u007f]/.test(value)) return null;
  const relative = value.startsWith("/") && !value.startsWith("//");
  try {
    const url = new URL(value, baseUrl ?? (relative ? "https://relative.invalid" : undefined));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const kept = new URLSearchParams();
    for (const [key, parameter] of url.searchParams) {
      if (resourceParameters.has(key) && /^[0-9]{1,20}$/.test(parameter)) kept.append(key, parameter);
    }
    url.search = kept.toString();
    url.hash = "";
    return relative && !baseUrl ? url.pathname + url.search : url.href;
  } catch {
    return null;
  }
}

function removedUrlParts(value: string, baseUrl?: string): boolean {
  try {
    const original = new URL(value, baseUrl ?? "https://relative.invalid");
    const safe = safePublicUrl(value, baseUrl);
    if (!safe) return true;
    const cleaned = new URL(safe, baseUrl ?? "https://relative.invalid");
    return original.search !== cleaned.search || original.hash !== cleaned.hash;
  } catch { return true; }
}

// URLs may be visible text, not just hrefs (including signed meeting links).
function safeVisibleText(value: string, baseUrl?: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, original => {
    const safe = safePublicUrl(original, baseUrl);
    if (!safe) return "[URL omitted]";
    return safe + (removedUrlParts(original, baseUrl) ? " [Link parameters omitted]" : "");
  });
}

/** Parse before applying a small formatting allowlist; raw HTML is never regex-sanitized. */
export function sanitizeHtml(value: unknown, baseUrl?: string): string | null {
  if (typeof value !== "string") return null;
  return convert(value, true, baseUrl);
}

/** Full text from already bounded rich content; no silent character truncation. */
export function plainText(html: string | null): string | null {
  if (html === null) return null;
  return convert(html, false)
    .replace(/[\t\r\f ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Iteration avoids recursion limits on deeply nested but byte-bounded HTML.
function convert(input: string, html: boolean, baseUrl?: string): string {
  const pending: Array<Node | string> = [...parseFragment(input).childNodes].reverse();
  const output: string[] = [];
  while (pending.length) {
    const node = pending.pop()!;
    if (typeof node === "string") {
      output.push(node);
      continue;
    }
    if (node.nodeName === "#text") {
      const text = safeVisibleText((node as DefaultTreeAdapterMap["textNode"]).value, baseUrl);
      output.push(html ? escapeText(text) : text);
      continue;
    }
    if (!("tagName" in node)) continue;
    if (["iframe", "object", "embed"].includes(node.tagName)) {
      const rawSource = node.attrs.find(attribute => attribute.name === "src" || attribute.name === "data")?.value;
      const candidate = safePublicUrl(rawSource, baseUrl);
      const source = candidate && /^(?:https:\/\/learning\.hanyang\.ac\.kr)?\/(?:courses\/\d+\/)?files\/\d+(?:\/|\?|$)/.test(candidate) ? candidate : null;
      const label = "[Embedded content not read]";
      output.push(html && source ? `<a href="${escapeText(source).replace(/"/g, "&quot;")}">${label}</a>`
        : `${label}${source ? ` ${source}` : ""}`);
      continue;
    }
    if (excludedTags.has(node.tagName)) continue;
    if (node.tagName === "img") {
      const label = safeVisibleText(node.attrs.find((attribute) => attribute.name === "alt")?.value || "[Image not read]", baseUrl);
      const source = safePublicUrl(node.attrs.find((attribute) => attribute.name === "src")?.value, baseUrl);
      output.push(html && source
        ? `<a href="${escapeText(source).replace(/"/g, "&quot;")}">${escapeText(label)}</a>`
        : html ? escapeText(label) : label);
      continue;
    }
    if (html && allowedTags.has(node.tagName)) {
      const rawHref = node.tagName === "a" ? node.attrs.find((attribute) => attribute.name === "href")?.value : undefined;
      const href = node.tagName === "a"
        ? safePublicUrl(rawHref, baseUrl)
        : null;
      const attributes = href ? ` href="${escapeText(href).replace(/"/g, "&quot;")}"` : "";
      output.push(`<${node.tagName}${attributes}>`);
      if (rawHref && removedUrlParts(rawHref, baseUrl)) pending.push(" [Link parameters omitted]");
      if (node.tagName !== "br" && node.tagName !== "hr") pending.push(`</${node.tagName}>`);
    } else if (!html && blockTags.has(node.tagName)) {
      output.push("\n");
      pending.push("\n");
    }
    for (let index = node.childNodes.length - 1; index >= 0; index -= 1) pending.push(node.childNodes[index]!);
  }
  return output.join("");
}
