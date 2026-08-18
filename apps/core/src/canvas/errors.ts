export type CanvasErrorCode =
  | "configuration_error"
  | "invalid_argument"
  | "authentication_failed"
  | "permission_denied"
  | "not_found"
  | "rate_limited"
  | "canvas_error"
  | "upstream_error"
  | "timeout"
  | "network_error"
  | "invalid_response"
  | "unsafe_pagination";

export interface CanvasErrorDetails {
  status: number | null;
  retryable: boolean;
  requestId: string | null;
  retryAfterSeconds: number | null;
}

/** A stable, token-safe error surfaced by the Canvas client. */
export class CanvasApiError extends Error {
  readonly code: CanvasErrorCode;
  readonly status: number | null;
  readonly retryable: boolean;
  readonly requestId: string | null;
  readonly retryAfterSeconds: number | null;

  constructor(
    code: CanvasErrorCode,
    message: string,
    details: Partial<CanvasErrorDetails> = {},
    options: ErrorOptions = {},
  ) {
    super(message, options);
    this.name = "CanvasApiError";
    this.code = code;
    this.status = details.status ?? null;
    this.retryable = details.retryable ?? false;
    this.requestId = details.requestId ?? null;
    this.retryAfterSeconds = details.retryAfterSeconds ?? null;
  }

  toJSON(): {
    code: CanvasErrorCode;
    message: string;
    status: number | null;
    retryable: boolean;
    requestId: string | null;
    retryAfterSeconds: number | null;
  } {
    return {
      code: this.code,
      message: this.message,
      status: this.status,
      retryable: this.retryable,
      requestId: this.requestId,
      retryAfterSeconds: this.retryAfterSeconds,
    };
  }
}

export function asCanvasApiError(error: unknown): CanvasApiError {
  if (error instanceof CanvasApiError) {
    return error;
  }

  return new CanvasApiError(
    "network_error",
    "Canvas request failed before a valid response was received.",
    { retryable: true },
    error instanceof Error ? { cause: error } : {},
  );
}
