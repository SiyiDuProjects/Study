type LogLevel = "debug" | "info" | "warn" | "error";

const SECRET_KEY = /(?:authorization|cookie|token|secret|password|credential|assertion|pat|code_verifier)/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 4) return "[truncated]";
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: process.env.NODE_ENV === "production" ? undefined : value.stack,
    };
  }
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .slice(0, 50)
        .map(([key, item]) => [key, SECRET_KEY.test(key) ? "[redacted]" : sanitize(item, depth + 1)]),
    );
  }
  if (typeof value === "string" && value.length > 1_000) {
    return `${value.slice(0, 1_000)}…`;
  }
  return value;
}

export function log(level: LogLevel, event: string, fields: Record<string, unknown> = {}): void {
  const configured = process.env.LOG_LEVEL ?? "info";
  const order: LogLevel[] = ["debug", "info", "warn", "error"];
  if (order.indexOf(level) < order.indexOf(configured as LogLevel)) return;

  const line = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...sanitize(fields) as Record<string, unknown>,
  });
  (level === "error" ? console.error : level === "warn" ? console.warn : console.log)(line);
}
