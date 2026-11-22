// Refresh-grant health check for the stored Google Drive connection.
//
// This module stays free of the Cloudflare Worker environment
// ("cloudflare:workers", D1, secrets) so the outcome mapping can run under
// `node --test` with a stubbed token endpoint. Callers inject every value the
// check needs; nothing sensitive is returned beyond a minted access token.

export type DriveGrantCheck =
  | { outcome: "healthy"; accessToken: string; expiresIn: number }
  | { outcome: "expired" }
  | { outcome: "misconfigured" }
  | { outcome: "unverified" };

type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;

type DriveTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// The grant probe runs inside the dashboard status request, so it must never
// stall: a hung token endpoint reports "unverified" after this many
// milliseconds instead of holding the whole response.
export const GRANT_CHECK_TIMEOUT_MS = 8_000;

// Failure categories reported to operators. They intentionally carry no
// tokens, provider payloads, or error descriptions — only how the check
// failed and the HTTP status when there is one.
export type DriveGrantCheckFailure = {
  category: "network" | "http_status" | "malformed_response" | "expired" | "misconfigured";
  status?: number;
};

// Google's token endpoint marks a dead user grant specifically through
// `invalid_grant` (revoked or expired consent). Only reconnecting the account
// can repair it.
function grantExpired(error: string | undefined) {
  return error === "invalid_grant";
}

// `invalid_client` (wrong client ID/secret) and `unauthorized_client` (the
// client is not allowed to use this grant) are OAuth client-configuration
// problems: reconnecting cannot fix them, so they must be told apart from a
// dead user grant — and from transient failures — in the dashboard.
function clientMisconfigured(error: string | undefined) {
  return error === "invalid_client" || error === "unauthorized_client";
}

function defaultFailureLog(failure: DriveGrantCheckFailure) {
  console.warn(
    `[google-drive-grant] refresh check failed: ${failure.category}${failure.status === undefined ? "" : ` (HTTP ${failure.status})`}`,
  );
}

export async function checkDriveRefreshGrant(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: TokenFetch;
  timeoutMs?: number;
  onFailure?: (failure: DriveGrantCheckFailure) => void;
}): Promise<DriveGrantCheck> {
  const request = options.fetchImpl ?? fetch;
  const report = options.onFailure ?? defaultFailureLog;
  let response: Response;
  try {
    response = await request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? GRANT_CHECK_TIMEOUT_MS),
    });
  } catch {
    report({ category: "network" });
    return { outcome: "unverified" };
  }
  let token: DriveTokenResponse;
  try {
    const payload: unknown = await response.json();
    // Guard against a JSON body that is not an object at all ("null", arrays).
    token = typeof payload === "object" && payload !== null ? payload as DriveTokenResponse : {};
  } catch {
    report({ category: "malformed_response", status: response.status });
    return { outcome: "unverified" };
  }
  if (response.ok && token.access_token) {
    return {
      outcome: "healthy",
      accessToken: token.access_token,
      expiresIn: token.expires_in ?? 3600,
    };
  }
  if (grantExpired(token.error)) {
    report({ category: "expired", status: response.status });
    return { outcome: "expired" };
  }
  if (clientMisconfigured(token.error)) {
    report({ category: "misconfigured", status: response.status });
    return { outcome: "misconfigured" };
  }
  report({ category: response.ok ? "malformed_response" : "http_status", status: response.status });
  return { outcome: "unverified" };
}

export type CachedAccessToken = {
  token: string;
  expiresAt: number;
  connectionUpdatedAt: number;
};

export type StoredDriveGrant = {
  // Version of the connection row the grant belongs to. Reconnecting rewrites
  // the row, which invalidates access tokens cached for the previous grant.
  connectionUpdatedAt: number;
  // Resolves the stored refresh token. Throws when it can no longer be
  // decrypted (for example after SESSION_SECRET changed) — only reconnecting
  // can repair that, so it is reported as "expired".
  decryptRefreshToken: () => Promise<string>;
};

// Owns the access-token cache shared by the status probe and the Drive API
// path. `verify` always exercises the stored refresh grant against Google;
// `accessTokenHealth` may reuse a still-fresh minted token because the refresh
// path recovers when a cached token dies early.
export function createDriveGrantHealth(options: {
  checkGrant: (refreshToken: string) => Promise<DriveGrantCheck>;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  let cache: CachedAccessToken | null = null;

  // Always checks the refresh grant itself — never a cached access token — so
  // a revoked grant cannot hide behind a token that has not expired yet.
  async function verify(grant: StoredDriveGrant): Promise<DriveGrantCheck> {
    let refreshToken: string;
    try {
      refreshToken = await grant.decryptRefreshToken();
    } catch {
      return { outcome: "expired" };
    }
    const check = await options.checkGrant(refreshToken);
    if (check.outcome === "healthy") {
      cache = {
        token: check.accessToken,
        expiresAt: now() + Math.max(300, check.expiresIn) * 1000,
        connectionUpdatedAt: grant.connectionUpdatedAt,
      };
    }
    return check;
  }

  async function accessTokenHealth(grant: StoredDriveGrant): Promise<DriveGrantCheck> {
    if (cache && cache.connectionUpdatedAt === grant.connectionUpdatedAt && cache.expiresAt > now() + 60_000) {
      return {
        outcome: "healthy",
        accessToken: cache.token,
        expiresIn: Math.floor((cache.expiresAt - now()) / 1000),
      };
    }
    return verify(grant);
  }

  return {
    verify,
    accessTokenHealth,
    // Lets the OAuth callback seed the cache with the just-minted token.
    seedCache(entry: CachedAccessToken | null) {
      cache = entry;
    },
  };
}

export type DriveStatusReason = "expired" | "unverified" | "misconfigured" | null;

export type DriveConnectionStatus = {
  configured: boolean;
  connected: boolean;
  email: string | null;
  rootFolderId: string | null;
  // Machine-readable guidance for the host dashboard. "expired" means the
  // stored grant was revoked, expired, or can no longer be decrypted — the
  // account must be reconnected. "misconfigured" means Google rejected the
  // Worker's OAuth client credentials — the host must fix the Worker settings,
  // reconnecting alone will not help. "unverified" means the grant could not
  // be checked right now (transient failure), so no action is required yet.
  reason: DriveStatusReason;
};

// Maps connection-row state plus the grant probe to the status payload the
// host dashboard consumes. The probe only runs when a connection exists and
// OAuth is configured, so a null grant means "nothing to report" — connected
// stays true and no reason is surfaced.
export function driveConnectionStatus(options: {
  configured: boolean;
  connection: { email: string; rootFolderId: string | null } | null;
  grant: DriveGrantCheck | null;
}): DriveConnectionStatus {
  return {
    configured: options.configured,
    connected: Boolean(options.connection),
    email: options.connection?.email ?? null,
    rootFolderId: options.connection?.rootFolderId ?? null,
    reason: options.grant && options.grant.outcome !== "healthy" ? options.grant.outcome : null,
  };
}

export type FailedDriveGrant = Exclude<DriveGrantCheck, { outcome: "healthy" }>;

// Callers that needed an access token surface a failed check as an error.
// "expired" means only reconnecting can repair the grant and "misconfigured"
// means the Worker credentials are wrong, so those messages point at the fix;
// anything else is transient — the grant may still be valid — so it reports a
// retryable problem instead of reconnect guidance.
export function failedGrantError(check: FailedDriveGrant): { message: string; status: number } {
  if (check.outcome === "expired") {
    return { message: "Google Drive authorization expired. Connect it again from the host dashboard.", status: 503 };
  }
  if (check.outcome === "misconfigured") {
    return {
      message: "Google Drive OAuth client credentials are invalid. Correct GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in the Worker settings.",
      status: 503,
    };
  }
  return { message: "Google Drive could not be verified right now. Try again.", status: 503 };
}
