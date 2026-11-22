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
