import assert from "node:assert/strict";
import { test } from "node:test";

// lib/google-drive-grant.ts is plain TypeScript without Worker bindings, so
// `node --test` can import it directly. Node >= 22.18 strips type annotations
// by default; on older 22.x runtimes the import fails with
// ERR_UNKNOWN_FILE_EXTENSION and these checks report as skipped instead of
// failing the suite. Every other import failure — a syntax error, a broken
// import inside the module — must surface as a test failure, not a skip.
let grantModule;
try {
  grantModule = await import("../lib/google-drive-grant.ts");
} catch (error) {
  if (error?.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw error;
}
const { checkDriveRefreshGrant, createDriveGrantHealth, driveConnectionStatus, failedGrantError } = grantModule ?? {};
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

test("unauthorized_client maps to misconfigured — the OAuth client, not the user grant, is the problem", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const result = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => tokenResponse(400, { error: "unauthorized_client" }),
  });
  assert.deepEqual(result, { outcome: "misconfigured" });
});

test("invalid_client maps to misconfigured — bad Worker credentials need fixing, not reconnecting", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const result = await checkDriveRefreshGrant({
    ...OPTIONS,
    fetchImpl: async () => tokenResponse(401, { error: "invalid_client" }),
  });
  assert.deepEqual(result, { outcome: "misconfigured" });
});

test("a stalled token endpoint reports unverified once the probe timeout fires", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const failures = [];
  const result = await checkDriveRefreshGrant({
    ...OPTIONS,
    timeoutMs: 25,
    onFailure: (failure) => failures.push(failure),
    fetchImpl: (_url, init) => new Promise((_, reject) => {
      init.signal.addEventListener("abort", () => reject(init.signal.reason));
    }),
  });
  assert.deepEqual(result, { outcome: "unverified" });
  assert.deepEqual(failures, [{ category: "network" }]);
});

test("grant probe failures report a sanitized category and HTTP status only", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const failures = [];
  const onFailure = (failure) => failures.push(failure);
  await checkDriveRefreshGrant({
    ...OPTIONS, onFailure,
    fetchImpl: async () => tokenResponse(500, { error: "backendError" }),
  });
  assert.deepEqual(failures, [{ category: "http_status", status: 500 }]);
  failures.length = 0;
  await checkDriveRefreshGrant({
    ...OPTIONS, onFailure,
    fetchImpl: async () => tokenResponse(200, {}),
  });
  assert.deepEqual(failures, [{ category: "malformed_response", status: 200 }]);
  failures.length = 0;
  await checkDriveRefreshGrant({
    ...OPTIONS, onFailure,
    fetchImpl: async () => { throw new Error("network unreachable"); },
  });
  assert.deepEqual(failures, [{ category: "network" }]);
  // Nothing sensitive may leak into the operator trace.
  assert.equal(JSON.stringify(failures).includes(OPTIONS.refreshToken), false);
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

test("status verification ignores a cached access token and reports a revoked grant as expired", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  let grantChecks = 0;
  const health = createDriveGrantHealth({
    checkGrant: async (refreshToken) => {
      grantChecks += 1;
      assert.equal(refreshToken, "stored-refresh-token");
      return { outcome: "expired" };
    },
  });
  // A still-fresh cached access token must not make the status probe report
  // healthy while the refresh grant behind it has been revoked.
  health.seedCache({ token: "cached-access-token", expiresAt: Date.now() + 3600_000, connectionUpdatedAt: 7 });
  const result = await health.verify({ connectionUpdatedAt: 7, decryptRefreshToken: async () => "stored-refresh-token" });
  assert.deepEqual(result, { outcome: "expired" });
  assert.equal(grantChecks, 1);
});

test("the access-token fast path still reuses a fresh cached token without re-checking the grant", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  let grantChecks = 0;
  const health = createDriveGrantHealth({
    checkGrant: async () => {
      grantChecks += 1;
      return { outcome: "expired" };
    },
  });
  health.seedCache({ token: "cached-access-token", expiresAt: Date.now() + 3600_000, connectionUpdatedAt: 7 });
  const result = await health.accessTokenHealth({
    connectionUpdatedAt: 7,
    decryptRefreshToken: async () => { throw new Error("decrypt must not run while the cache is fresh"); },
  });
  assert.equal(result.outcome, "healthy");
  if (result.outcome === "healthy") assert.equal(result.accessToken, "cached-access-token");
  assert.equal(grantChecks, 0);
});

test("an unverified grant maps to a transient error instead of reconnect guidance", { skip: !checkDriveRefreshGrant && SKIP_REASON }, async () => {
  const health = createDriveGrantHealth({
    checkGrant: (refreshToken) =>
      checkDriveRefreshGrant({
        ...OPTIONS,
        refreshToken,
        fetchImpl: async () => tokenResponse(500, { error: "backendError" }),
      }),
  });
  const check = await health.accessTokenHealth({ connectionUpdatedAt: 1, decryptRefreshToken: async () => OPTIONS.refreshToken });
  assert.deepEqual(check, { outcome: "unverified" });
  const failure = failedGrantError(check);
  assert.equal(failure.status, 503);
  assert.equal(failure.message.includes("Connect it again"), false);
  assert.equal(failure.message.includes("expired"), false);
  // The expired outcome keeps its reconnect guidance.
  assert.equal(failedGrantError({ outcome: "expired" }).message.includes("Connect it again"), true);
});

test("a misconfigured client maps to credential guidance, not reconnect guidance", { skip: !checkDriveRefreshGrant && SKIP_REASON }, () => {
  const failure = failedGrantError({ outcome: "misconfigured" });
  assert.equal(failure.status, 503);
  assert.equal(failure.message.includes("GOOGLE_CLIENT_ID"), true);
  assert.equal(failure.message.includes("GOOGLE_CLIENT_SECRET"), true);
  assert.equal(failure.message.includes("Connect it again"), false);
});

// The status endpoint delegates to driveConnectionStatus; these cases lock
// the mapping the dashboard renders against.
test("driveConnectionStatus maps the unconfigured and unconnected states", { skip: !checkDriveRefreshGrant && SKIP_REASON }, () => {
  assert.deepEqual(
    driveConnectionStatus({ configured: false, connection: null, grant: null }),
    { configured: false, connected: false, email: null, rootFolderId: null, reason: null },
  );
  assert.deepEqual(
    driveConnectionStatus({ configured: true, connection: null, grant: null }),
    { configured: true, connected: false, email: null, rootFolderId: null, reason: null },
  );
});

test("driveConnectionStatus maps a healthy connection with no reason", { skip: !checkDriveRefreshGrant && SKIP_REASON }, () => {
  assert.deepEqual(
    driveConnectionStatus({
      configured: true,
      connection: { email: "host@example.com", rootFolderId: "root-1" },
      grant: { outcome: "healthy", accessToken: "token", expiresIn: 3600 },
    }),
    { configured: true, connected: true, email: "host@example.com", rootFolderId: "root-1", reason: null },
  );
  // A saved connection row without configured OAuth skips the probe entirely:
  // connected stays true and no guidance is surfaced.
  assert.deepEqual(
    driveConnectionStatus({
      configured: false,
      connection: { email: "host@example.com", rootFolderId: "root-1" },
      grant: null,
    }),
    { configured: false, connected: true, email: "host@example.com", rootFolderId: "root-1", reason: null },
  );
});

test("driveConnectionStatus surfaces each failed grant outcome as the reason", { skip: !checkDriveRefreshGrant && SKIP_REASON }, () => {
  const connection = { email: "host@example.com", rootFolderId: "root-1" };
  for (const outcome of ["expired", "unverified", "misconfigured"]) {
    assert.deepEqual(
      driveConnectionStatus({ configured: true, connection, grant: { outcome } }),
      { configured: true, connected: true, email: "host@example.com", rootFolderId: "root-1", reason: outcome },
    );
  }
});
