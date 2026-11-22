// Refresh-grant health check for the stored Google Drive connection.
//
// This module stays free of the Cloudflare Worker environment
// ("cloudflare:workers", D1, secrets) so the outcome mapping can run under
// `node --test` with a stubbed token endpoint. Callers inject every value the
// check needs; nothing sensitive is returned beyond a minted access token.

export type DriveGrantCheck =
  | { outcome: "healthy"; accessToken: string; expiresIn: number }
  | { outcome: "expired" }
  | { outcome: "unverified" };

type TokenFetch = (url: string, init: RequestInit) => Promise<Response>;

type DriveTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: string;
};

const TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

// Google's token endpoint reports a dead refresh grant specifically through
// `invalid_grant` (revoked or expired consent) and `unauthorized_client`.
// Every other failure — 5xx, quota, malformed payloads, network errors — says
// nothing about the grant itself, so it must not trigger reconnect guidance.
function grantExpired(error: string | undefined) {
  return error === "invalid_grant" || error === "unauthorized_client";
}

export async function checkDriveRefreshGrant(options: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  fetchImpl?: TokenFetch;
}): Promise<DriveGrantCheck> {
  const request = options.fetchImpl ?? fetch;
  let token: DriveTokenResponse;
  try {
    const response = await request(TOKEN_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: options.clientId,
        client_secret: options.clientSecret,
        refresh_token: options.refreshToken,
        grant_type: "refresh_token",
      }),
    });
    token = await response.json() as DriveTokenResponse;
    if (response.ok && token.access_token) {
      return {
        outcome: "healthy",
        accessToken: token.access_token,
        expiresIn: token.expires_in ?? 3600,
      };
    }
  } catch {
    return { outcome: "unverified" };
  }
  return grantExpired(token.error) ? { outcome: "expired" } : { outcome: "unverified" };
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

export type FailedDriveGrant = Exclude<DriveGrantCheck, { outcome: "healthy" }>;

// Callers that needed an access token surface a failed check as an error.
// "expired" means only reconnecting can repair the grant, so the message
// points at the dashboard; anything else is transient — the grant may still
// be valid — so it reports a retryable problem instead of reconnect guidance.
export function failedGrantError(check: FailedDriveGrant): { message: string; status: number } {
  if (check.outcome === "expired") {
    return { message: "Google Drive authorization expired. Connect it again from the host dashboard.", status: 503 };
  }
  return { message: "Google Drive could not be verified right now. Try again.", status: 503 };
}
