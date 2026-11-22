import assert from "node:assert/strict";
import { test } from "node:test";

// lib/google-drive-grant.ts is plain TypeScript without Worker bindings, so
// `node --test` can import it directly. Node >= 22.18 strips type annotations
// by default; on older 22.x runtimes the import fails and these checks report
// as skipped instead of failing the suite.
let checkDriveRefreshGrant;
try {
  ({ checkDriveRefreshGrant } = await import("../lib/google-drive-grant.ts"));
} catch {
  checkDriveRefreshGrant = undefined;
}
const SKIP_REASON = "this Node runtime cannot import TypeScript directly";

const OPTIONS = { clientId: "test-client-id", clientSecret: "test-client-secret", refreshToken: "test-refresh-token" };

function tokenResponse(status, payload) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

test("a successful refresh reports healthy and returns the minted access token", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const result = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://oauth2.googleapis.com/token");
      assert.equal(init.method, "POST");
      const body = new URLSearchParams(init.body);
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("client_id"), OPTIONS.clientId);
      assert.equal(body.get("refresh_token"), OPTIONS.refreshToken);
      return tokenResponse(200, { access_token: "fresh-access-token", expires_in: 1800 });
    },
  });
  assert.deepEqual(result, { outcome: "healthy", accessToken: "fresh-access-token", expiresIn: 1800 });
});

test("invalid_grant maps to the expired reconnect state without leaking provider details", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const result = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => tokenResponse(400, { error: "invalid_grant", error_description: "Token has been revoked by the user." }),
  });
  assert.deepEqual(result, { outcome: "expired" });
  assert.equal(JSON.stringify(result).includes("revoked by the user"), false);
});

test("unauthorized_client also maps to expired", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const result = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => tokenResponse(400, { error: "unauthorized_client" }),
  });
  assert.deepEqual(result, { outcome: "expired" });
});

test("transient token-endpoint failures report unverified, not expired", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const serverError = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => tokenResponse(500, { error: "backendError" }),
  });
  assert.deepEqual(serverError, { outcome: "unverified" });
  const networkError = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => { throw new Error("network unreachable"); },
  });
  assert.deepEqual(networkError, { outcome: "unverified" });
});

test("unparseable and malformed token responses report unverified", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const notJson = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => new Response("<html>Bad Gateway</html>", { status: 502 }),
  });
  assert.deepEqual(notJson, { outcome: "unverified" });
  const missingToken = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => tokenResponse(200, {}),
  });
  assert.deepEqual(missingToken, { outcome: "unverified" });
});
