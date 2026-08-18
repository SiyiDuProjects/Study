export class AuthError extends Error {
  readonly status: number;
  readonly code: string;
  readonly oauthError: string | undefined;

  constructor(code: string, message: string, status = 400, oauthError?: string) {
    super(message);
    this.name = "AuthError";
    this.status = status;
    this.code = code;
    this.oauthError = oauthError;
  }
}

export function invalidGrant(message = "The OAuth grant is invalid or expired"): AuthError {
  return new AuthError("invalid_grant", message, 400, "invalid_grant");
}

export function invalidClient(message = "The OAuth client is invalid"): AuthError {
  return new AuthError("invalid_client", message, 400, "invalid_client");
}

export function invalidRequest(message: string): AuthError {
  return new AuthError("invalid_request", message, 400, "invalid_request");
}
