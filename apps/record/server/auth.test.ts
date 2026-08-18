// @vitest-environment node
import { generateKeyPairSync, sign } from "node:crypto";
import type { Request } from "express";
import { describe, expect, it, vi } from "vitest";
import {
  AuthFailure,
  createCloudflareAccessAuthenticator,
  createConfiguredBrowserAuthenticator,
  PUBLIC_BROWSER_OWNER_EMAIL
} from "./auth.js";

describe("configured browser authentication", () => {
  it("requires an explicit production auth mode", () => {
    expect(() => createConfiguredBrowserAuthenticator({ production: true })).toThrow(
      /LECTURE_AUTH_MODE must be explicitly configured/
    );
    expect(() => createConfiguredBrowserAuthenticator({ production: true, authMode: "PUBLIC" })).toThrow(
      /must be exactly public or cloudflare-access/
    );
  });

  it("maps every public browser request to one fixed non-PII owner", async () => {
    const authenticate = createConfiguredBrowserAuthenticator({
      production: true,
      authMode: "public",
      // Public mode must not inspect or require any Cloudflare Access setting.
      teamDomain: "https://not-the-access-team.example",
      audience: "",
      ownerEmail: ""
    });

    const first = await authenticate({} as Request);
    const second = await authenticate({ headers: { "x-forwarded-for": "203.0.113.8" } } as unknown as Request);
    expect(first).toEqual({ email: PUBLIC_BROWSER_OWNER_EMAIL });
    expect(second).toEqual(first);
  });

  it("still fails closed when Access mode is selected without its complete configuration", () => {
    expect(() => createConfiguredBrowserAuthenticator({
      production: true,
      authMode: "cloudflare-access",
      teamDomain: "https://gaid.cloudflareaccess.com"
    })).toThrow(/CF_ACCESS_TEAM_DOMAIN, CF_ACCESS_AUD, and LECTURE_OWNER_EMAIL are required/);
  });
});

describe("Cloudflare Access authentication", () => {
  it("verifies signature, issuer, audience, expiry, and the single Hanyang owner", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = { ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256" };
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({ keys: [jwk] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    }));
    const authenticate = createCloudflareAccessAuthenticator({
      teamDomain: "https://gaid.cloudflareaccess.com",
      audience: "lecture-audience",
      ownerEmail: "owner@example.com",
      fetchImpl
    });
    const token = jwt(privateKey, {
      iss: "https://gaid.cloudflareaccess.com",
      aud: ["lecture-audience"],
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "OWNER@example.com"
    });

    await expect(authenticate(requestWithToken(token))).resolves.toEqual({ email: "owner@example.com" });
  });

  it("rejects a correctly signed token for another Access application", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      keys: [{ ...publicKey.export({ format: "jwk" }), kid: "key-1", alg: "RS256" }]
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const authenticate = createCloudflareAccessAuthenticator({
      teamDomain: "https://gaid.cloudflareaccess.com",
      audience: "lecture-audience",
      ownerEmail: "owner@example.com",
      fetchImpl
    });
    const token = jwt(privateKey, {
      iss: "https://gaid.cloudflareaccess.com",
      aud: ["wrong-audience"],
      exp: Math.floor(Date.now() / 1000) + 300,
      email: "owner@example.com"
    });

    await expect(authenticate(requestWithToken(token))).rejects.toBeInstanceOf(AuthFailure);
  });
});

function jwt(privateKey: ReturnType<typeof generateKeyPairSync>["privateKey"], claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", kid: "key-1", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signature = sign("RSA-SHA256", Buffer.from(`${header}.${payload}`), privateKey).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

function requestWithToken(token: string): Request {
  return { header: (name: string) => name.toLowerCase() === "cf-access-jwt-assertion" ? token : undefined } as Request;
}
