/*
 * Browser/API contract. Keep every route here so the server can change its
 * mount points without hunting through page-specific handlers.
 */
export const API_ENDPOINTS = Object.freeze({
  session: "/auth/session",
  registrationOptions: "/auth/register/options",
  registrationVerify: "/auth/register/verify",
  loginOptions: "/auth/login/options",
  loginVerify: "/auth/login/verify",
  stepUpOptions: "/api/account/step-up/options",
  stepUpVerify: "/api/account/step-up/verify",
  passkeyOptions: "/api/account/passkeys/options",
  passkeyVerify: "/api/account/passkeys/verify",
  logout: "/auth/logout",
  account: "/api/account",
  replaceCanvasToken: "/api/account/canvas-token",
  deleteAccount: "/api/account/delete",
});

let csrfToken = "";

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function setStatus(element, message, kind = "info") {
  if (!element) return;
  element.textContent = message;
  element.dataset.kind = kind;
  element.setAttribute("role", kind === "error" ? "alert" : "status");
}

function setBusy(button, busy, busyText) {
  if (!button) return;
  if (busy) {
    button.dataset.originalLabel = button.textContent || "Continue";
    button.textContent = busyText;
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    return;
  }
  button.textContent = button.dataset.originalLabel || button.textContent;
  button.disabled = false;
  button.removeAttribute("aria-busy");
}

function errorMessage(error) {
  if (error instanceof DOMException && error.name === "NotAllowedError") {
    return "The passkey request was canceled or timed out. Please try again.";
  }
  if (error instanceof DOMException && error.name === "InvalidStateError") {
    return "That passkey is already registered on this account.";
  }
  if (error instanceof ApiError || error instanceof Error) return error.message;
  return "Something went wrong. Please try again.";
}

async function api(path, options = {}) {
  const method = options.method || "GET";
  const headers = new Headers({ Accept: "application/json" });
  if (options.body !== undefined) headers.set("Content-Type", "application/json");
  if (method !== "GET" && method !== "HEAD" && csrfToken) {
    headers.set("X-CSRF-Token", csrfToken);
  }

  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    credentials: "same-origin",
    cache: "no-store",
  });

  const contentType = response.headers.get("content-type") || "";
  let payload = null;
  if (contentType.includes("application/json")) {
    payload = await response.json().catch(() => null);
  }

  const nextCsrfToken = payload && typeof payload.csrfToken === "string"
    ? payload.csrfToken
    : response.headers.get("x-csrf-token");
  if (nextCsrfToken) csrfToken = nextCsrfToken;

  if (!response.ok) {
    const message = payload?.error?.message || payload?.message || `Request failed (${response.status}).`;
    throw new ApiError(message, response.status);
  }
  return payload || {};
}

async function loadSession(returnTo) {
  if (!returnTo) return api(API_ENDPOINTS.session);
  const query = new URLSearchParams({ returnTo });
  return api(`${API_ENDPOINTS.session}?${query.toString()}`);
}

function requestedReturnTo(fallback = "/account") {
  const raw = new URL(window.location.href).searchParams.get("returnTo");
  if (!raw || !raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\")) return fallback;
  const destination = new URL(raw, window.location.origin);
  if (destination.origin !== window.location.origin) return fallback;
  return `${destination.pathname}${destination.search}${destination.hash}`;
}

function requireWebAuthn() {
  if (!window.isSecureContext) {
    throw new Error("Passkeys require HTTPS, except on localhost.");
  }
  if (!("PublicKeyCredential" in window) || !("credentials" in navigator)) {
    throw new Error("This browser does not support passkeys. Try an up-to-date browser or device.");
  }
}

function decodeBase64Url(value) {
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return value;
  if (typeof value !== "string") throw new TypeError("Expected a base64url string.");
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(normalized + padding);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes.buffer;
}

function encodeBase64Url(value) {
  if (value === null || value === undefined) return null;
  const bytes = value instanceof ArrayBuffer
    ? new Uint8Array(value)
    : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}

function publicKeyPayload(payload) {
  const options = payload?.publicKey || payload?.options?.publicKey || payload?.options;
  if (!options || typeof options !== "object") {
    throw new Error("The server returned invalid passkey options.");
  }
  return options;
}

function creationOptionsFromJson(payload) {
  const options = publicKeyPayload(payload);
  if (typeof PublicKeyCredential.parseCreationOptionsFromJSON === "function") {
    return PublicKeyCredential.parseCreationOptionsFromJSON(options);
  }
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    user: { ...options.user, id: decodeBase64Url(options.user.id) },
    excludeCredentials: (options.excludeCredentials || []).map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  };
}

function requestOptionsFromJson(payload) {
  const options = publicKeyPayload(payload);
  if (typeof PublicKeyCredential.parseRequestOptionsFromJSON === "function") {
    return PublicKeyCredential.parseRequestOptionsFromJSON(options);
  }
  return {
    ...options,
    challenge: decodeBase64Url(options.challenge),
    allowCredentials: (options.allowCredentials || []).map((credential) => ({
      ...credential,
      id: decodeBase64Url(credential.id),
    })),
  };
}

function registrationCredentialToJson(credential) {
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || null,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      attestationObject: encodeBase64Url(credential.response.attestationObject),
      transports: typeof credential.response.getTransports === "function"
        ? credential.response.getTransports()
        : [],
      publicKeyAlgorithm: typeof credential.response.getPublicKeyAlgorithm === "function"
        ? credential.response.getPublicKeyAlgorithm()
        : undefined,
    },
  };
}

function authenticationCredentialToJson(credential) {
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment || null,
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: encodeBase64Url(credential.response.clientDataJSON),
      authenticatorData: encodeBase64Url(credential.response.authenticatorData),
      signature: encodeBase64Url(credential.response.signature),
      userHandle: encodeBase64Url(credential.response.userHandle),
    },
  };
}

function flowIdFrom(payload) {
  const flowId = payload?.flowId || payload?.registrationId || payload?.authenticationId;
  if (typeof flowId !== "string" || !flowId) {
    throw new Error("The server did not return a passkey flow identifier.");
  }
  return flowId;
}

function redirectSameOrigin(candidate, fallback) {
  const destination = new URL(candidate || fallback, window.location.origin);
  if (destination.origin !== window.location.origin) {
    throw new Error("The server returned an unsafe redirect.");
  }
  window.location.assign(`${destination.pathname}${destination.search}${destination.hash}`);
}

async function createPasskey(optionsPayload) {
  requireWebAuthn();
  const credential = await navigator.credentials.create({
    publicKey: creationOptionsFromJson(optionsPayload),
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("No passkey credential was created.");
  }
  return registrationCredentialToJson(credential);
}

async function getPasskey(optionsPayload) {
  requireWebAuthn();
  const credential = await navigator.credentials.get({
    publicKey: requestOptionsFromJson(optionsPayload),
  });
  if (!(credential instanceof PublicKeyCredential)) {
    throw new Error("No passkey credential was returned.");
  }
  return authenticationCredentialToJson(credential);
}

async function performStepUp(action) {
  const options = await api(API_ENDPOINTS.stepUpOptions, {
    method: "POST",
    body: { action },
  });
  const credential = await getPasskey(options);
  const result = await api(API_ENDPOINTS.stepUpVerify, {
    method: "POST",
    body: { flowId: flowIdFrom(options), credential },
  });
  if (result.action !== action || typeof result.stepUpToken !== "string" || !result.stepUpToken) {
    throw new Error("The server returned an invalid step-up authorization.");
  }
  return result.stepUpToken;
}

function consumeInviteToken() {
  const url = new URL(window.location.href);
  const fragment = new URLSearchParams(url.hash.replace(/^#/, ""));
  const invitation = fragment.get("token") || "";
  url.hash = "";
  const cleaned = `${url.pathname}${url.search}`;
  window.history.replaceState(null, "", cleaned);
  return invitation;
}

async function initSetup() {
  const form = document.querySelector("#setup-form");
  const submit = document.querySelector("#setup-submit");
  const status = document.querySelector("#setup-status");
  const inviteInput = document.querySelector("#invite-token");
  const tokenInput = document.querySelector("#canvas-token");
  if (!form || !submit || !status || !inviteInput || !tokenInput) return;

  inviteInput.value = consumeInviteToken();
  try {
    requireWebAuthn();
    await loadSession();
  } catch (error) {
    setStatus(status, errorMessage(error), "error");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    setBusy(submit, true, "Creating secure passkey…");
    setStatus(status, "Validating the invitation and Canvas connection…");

    const formData = new FormData(form);
    const request = {
      inviteToken: String(formData.get("inviteToken") || "").trim(),
      pat: String(formData.get("canvasAccessToken") || "").trim(),
      deviceName: String(formData.get("deviceName") || "").trim(),
    };

    // Clear credential-like inputs before the network round trip completes.
    inviteInput.value = "";
    tokenInput.value = "";

    try {
      requireWebAuthn();
      const options = await api(API_ENDPOINTS.registrationOptions, {
        method: "POST",
        body: request,
      });
      setStatus(status, "Approve the passkey request on this device.");
      const credential = await createPasskey(options);
      const result = await api(API_ENDPOINTS.registrationVerify, {
        method: "POST",
        body: { flowId: flowIdFrom(options), credential },
      });
      setStatus(status, "Account connected. Opening account settings…", "success");
      redirectSameOrigin(result.redirectTo, "/account");
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
      setBusy(submit, false);
    }
  });
}

async function initLogin() {
  const button = document.querySelector("#login-button");
  const status = document.querySelector("#login-status");
  if (!button || !status) return;

  const returnTo = requestedReturnTo();
  try {
    requireWebAuthn();
    const session = await loadSession(returnTo);
    if (session.authenticated === true) {
      redirectSameOrigin(session.redirectTo, returnTo);
      return;
    }
  } catch (error) {
    setStatus(status, errorMessage(error), "error");
  }

  button.addEventListener("click", async () => {
    setBusy(button, true, "Waiting for your passkey…");
    setStatus(status, "Approve the sign-in request on this device.");
    try {
      requireWebAuthn();
      const options = await api(API_ENDPOINTS.loginOptions, { method: "POST", body: {} });
      const credential = await getPasskey(options);
      const result = await api(API_ENDPOINTS.loginVerify, {
        method: "POST",
        body: { flowId: flowIdFrom(options), credential, returnTo },
      });
      setStatus(status, "Signed in. Opening account settings…", "success");
      redirectSameOrigin(result.redirectTo, returnTo);
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
      setBusy(button, false);
    }
  });
}

function formatDate(value) {
  if (!value) return "Not yet";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "Unknown";
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function institutionName(value) {
  if (value === "hanyang") return "Hanyang HY-ON";
  return value || "Unknown";
}

function renderAccount(payload) {
  const user = payload.user || payload.account || payload;
  const connection = payload.connection || payload.canvas || user.connection || {};
  const values = {
    displayName: user.displayName || user.name || "Unknown",
    institution: institutionName(user.institution || connection.institution),
    canvasName: connection.canvasName || user.canvasName || "Configured user",
    connectionStatus: connection.status || (connection.connected === false ? "Not configured" : "Configured"),
    updatedAt: formatDate(connection.lastValidatedAt || connection.updatedAt),
  };
  for (const [key, value] of Object.entries(values)) {
    const element = document.querySelector(`[data-account-field="${key}"]`);
    if (element) element.textContent = value;
  }

  const list = document.querySelector("#passkey-list");
  if (!list) return;
  list.replaceChildren();
  const passkeys = Array.isArray(payload.passkeys) ? payload.passkeys : [];
  if (passkeys.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No passkey metadata returned.";
    list.append(item);
    return;
  }
  for (const passkey of passkeys) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    label.textContent = passkey.name || passkey.deviceName || "Passkey";
    const detail = document.createElement("div");
    detail.className = "meta";
    detail.textContent = `Created ${formatDate(passkey.createdAt)}${passkey.lastUsedAt ? ` · Last used ${formatDate(passkey.lastUsedAt)}` : ""}`;
    item.append(label, detail);
    list.append(item);
  }
}

async function initAccount() {
  const status = document.querySelector("#account-status");
  const content = document.querySelector("#account-content");
  const logoutButton = document.querySelector("#logout-button");
  const addPasskeyButton = document.querySelector("#add-passkey-button");
  const replaceTokenForm = document.querySelector("#replace-token-form");
  const replacementToken = document.querySelector("#replacement-token");
  const deleteButton = document.querySelector("#delete-account-button");
  const deleteConfirmation = document.querySelector("#delete-confirmation");
  if (!status || !content) return;

  const refreshAccount = async () => {
    const session = await loadSession();
    if (session.authenticated === false) {
      redirectSameOrigin(session.redirectTo, "/login");
      return;
    }
    const account = await api(API_ENDPOINTS.account);
    renderAccount(account);
    content.hidden = false;
    setStatus(status, "");
  };

  try {
    await refreshAccount();
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      redirectSameOrigin(null, "/login");
      return;
    }
    setStatus(status, errorMessage(error), "error");
  }

  logoutButton?.addEventListener("click", async () => {
    setBusy(logoutButton, true, "Signing out…");
    try {
      const result = await api(API_ENDPOINTS.logout, { method: "POST", body: {} });
      redirectSameOrigin(result.redirectTo, "/login");
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
      setBusy(logoutButton, false);
    }
  });

  addPasskeyButton?.addEventListener("click", async () => {
    const deviceName = window.prompt("Name this passkey (for example, Phone or Laptop):", "Additional passkey");
    if (deviceName === null) return;
    setBusy(addPasskeyButton, true, "Creating passkey…");
    setStatus(status, "Verify an existing passkey, then create the new passkey.");
    try {
      const stepUpToken = await performStepUp("add_passkey");
      const options = await api(API_ENDPOINTS.passkeyOptions, {
        method: "POST",
        body: { deviceName: deviceName.trim().slice(0, 80), stepUpToken },
      });
      const credential = await createPasskey(options);
      await api(API_ENDPOINTS.passkeyVerify, {
        method: "POST",
        body: { flowId: flowIdFrom(options), credential },
      });
      await refreshAccount();
      setStatus(status, "Passkey added.", "success");
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
    } finally {
      setBusy(addPasskeyButton, false);
    }
  });

  replaceTokenForm?.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!replaceTokenForm.reportValidity() || !replacementToken) return;
    const submit = replaceTokenForm.querySelector("button[type='submit']");
    const pat = replacementToken.value.trim();
    replacementToken.value = "";
    setBusy(submit, true, "Validating token…");
    try {
      await api(API_ENDPOINTS.replaceCanvasToken, {
        method: "POST",
        body: { pat },
      });
      await refreshAccount();
      setStatus(status, "Canvas access token replaced.", "success");
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
    } finally {
      setBusy(submit, false);
    }
  });

  deleteButton?.addEventListener("click", async () => {
    if (!deleteConfirmation || deleteConfirmation.value !== "DELETE") {
      setStatus(status, "Type DELETE exactly before deleting the account.", "error");
      deleteConfirmation?.focus();
      return;
    }
    if (!window.confirm("Delete this account and its stored Canvas connection? This cannot be undone.")) return;
    setBusy(deleteButton, true, "Deleting account…");
    try {
      setStatus(status, "Verify a passkey to authorize account deletion.");
      const stepUpToken = await performStepUp("delete_account");
      const result = await api(API_ENDPOINTS.deleteAccount, {
        method: "POST",
        body: { confirmation: "DELETE", stepUpToken },
      });
      redirectSameOrigin(result.redirectTo, "/");
    } catch (error) {
      setStatus(status, errorMessage(error), "error");
      setBusy(deleteButton, false);
    }
  });
}

const page = document.body.dataset.page;
if (page === "setup") initSetup();
if (page === "login") initLogin();
if (page === "account") initAccount();
