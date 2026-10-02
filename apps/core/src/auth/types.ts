import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { AppConfig } from "../config.js";
import type { AppDatabase } from "../db/index.js";
import type { CanvasConnection, CanvasIdentity, InstitutionKey } from "../domain.js";

export interface ValidatePatInput {
  institution: InstitutionKey;
  baseUrl: string;
  pat: string;
}

export type ValidatePat = (input: ValidatePatInput) => CanvasIdentity | Promise<CanvasIdentity>;

export interface AuthServiceOptions {
  db: AppDatabase;
  config: AppConfig;
  validatePat: ValidatePat;
  clock?: () => number;
}

export interface AuthenticatedUser {
  id: string;
  displayName: string;
  institution: InstitutionKey;
}

export interface AccountSummary {
  user: AuthenticatedUser;
  canvas: {
    institution: InstitutionKey;
    baseUrl: string;
    canvasUserId: string;
    canvasName: string;
    updatedAt: number;
  };
  passkeys: Array<{
    id: string;
    rpId: string;
    deviceName: string | null;
    createdAt: number;
    lastUsedAt: number | null;
  }>;
}

export interface SessionAuthentication {
  /** Internal stable identifier for binding privileged flows to this exact session. */
  sessionId: string;
  user: AuthenticatedUser;
  expiresAt: number;
}

export interface BearerAuthentication {
  userId: string;
  clientId: string;
  scope: string[];
  resource: string;
  expiresAt: number;
}

export type StepUpAction = "add_passkey" | "delete_account";
export type WebAuthnLoginMode = "auto" | "canonical" | "legacy" | "berkeley";

export interface OAuthAuthorizationInput {
  clientId: string;
  redirectUri: string;
  responseType: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  resource: string;
  scope?: string;
  state?: string;
}

export interface OAuthAuthorizationRequest extends OAuthAuthorizationInput {
  scope: string;
  scopes: string[];
  clientName: string;
}

export interface OAuthTokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  scope: string;
  refresh_token?: string;
}

export interface DynamicClientRegistrationInput {
  client_name?: string;
  redirect_uris: string[];
  grant_types?: string[];
  response_types?: string[];
  token_endpoint_auth_method?: string;
}

export interface DynamicClientRegistrationResponse {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
}

export interface AuthService {
  readonly config: AppConfig;
  createInvite(input: { institution: InstitutionKey; ttlSeconds?: number }): {
    inviteToken: string;
    expiresAt: number;
  };
  beginSetup(input: {
    inviteToken: string;
    pat: string;
    institution?: InstitutionKey;
    deviceName?: string;
  }): Promise<{
    flowId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>;
  finishSetup(input: { flowId: string; response: RegistrationResponseJSON }): Promise<{
    user: AuthenticatedUser;
    sessionToken: string;
    sessionExpiresAt: number;
  }>;
  beginPasskeyLogin(mode?: WebAuthnLoginMode): Promise<{
    flowId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>;
  finishPasskeyLogin(input: {
    flowId: string;
    response: AuthenticationResponseJSON;
  }): Promise<{
    user: AuthenticatedUser;
    sessionToken: string;
    sessionExpiresAt: number;
    migrationStepUpToken?: string;
    migrationStepUpExpiresAt?: number;
  }>;
  beginStepUp(userId: string, sessionId: string, action: StepUpAction): Promise<{
    flowId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }>;
  finishStepUp(input: {
    userId: string;
    sessionId: string;
    flowId: string;
    response: AuthenticationResponseJSON;
  }): Promise<{
    action: StepUpAction;
    stepUpToken: string;
    expiresAt: number;
  }>;
  beginPasskeyRegistration(input: {
    userId: string;
    sessionId: string;
    stepUpToken: string;
    deviceName?: string;
  }): Promise<{
    flowId: string;
    options: PublicKeyCredentialCreationOptionsJSON;
  }>;
  finishPasskeyRegistration(input: {
    userId: string;
    sessionId: string;
    flowId: string;
    response: RegistrationResponseJSON;
  }): Promise<{ passkeyId: string; deviceName: string | null }>;
  authenticateSession(sessionToken: string): SessionAuthentication;
  revokeSession(sessionToken: string): void;
  getAccountSummary(userId: string): AccountSummary;
  rotateCanvasPat(userId: string, pat: string): Promise<AccountSummary>;
  deleteAccount(userId: string, sessionId: string, stepUpToken: string): void;
  getCanvasConnection(userId: string): CanvasConnection;
  registerOAuthClient(input: DynamicClientRegistrationInput): DynamicClientRegistrationResponse;
  inspectAuthorizationRequest(input: OAuthAuthorizationInput): OAuthAuthorizationRequest;
  issueAuthorizationCode(userId: string, input: OAuthAuthorizationInput): {
    code: string;
    redirectTo: string;
  };
  exchangeAuthorizationCode(input: {
    code: string;
    clientId: string;
    redirectUri: string;
    codeVerifier: string;
    resource: string;
  }): OAuthTokenResponse;
  exchangeRefreshToken(input: {
    refreshToken: string;
    clientId: string;
    resource: string;
  }): OAuthTokenResponse;
  revokeOAuthToken(token: string): void;
  validateAccessToken(token: string, requiredScopes?: readonly string[]): BearerAuthentication;
  protectedResourceMetadata(): Record<string, unknown>;
  authorizationServerMetadata(): Record<string, unknown>;
}
