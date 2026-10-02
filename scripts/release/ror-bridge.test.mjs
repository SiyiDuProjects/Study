import assert from "node:assert/strict";
import test from "node:test";
import { handleRequest } from "../../infra/webauthn-ror-bridge/index.mjs";

test("legacy passkey bridge adds Study only for the approved Berkeley migration and keeps Hanyang unchanged", async () => {
  for (const [host, origins] of [
    ["canvas.gaid.studio", ["https://study.siyidu.com"]],
    ["berkeley-canvas.gaid.studio", ["https://berkeley.siyidu.com", "https://study.siyidu.com"]],
  ]) {
    const response = handleRequest(new Request(`https://${host}/.well-known/webauthn`));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { origins });
    assert.equal(await handleRequest(new Request(`https://${host}/.well-known/webauthn`, { method: "HEAD" })).text(), "");
  }
  for (const url of ["https://attacker.example/.well-known/webauthn", "https://canvas.gaid.studio/mcp", "http://canvas.gaid.studio/.well-known/webauthn", "https://canvas.gaid.studio/.well-known/webauthn?extra=1"]) {
    assert.equal(handleRequest(new Request(url)).status, 404);
  }
  assert.equal(handleRequest(new Request("https://canvas.gaid.studio/.well-known/webauthn", { method: "POST" })).status, 405);
});
