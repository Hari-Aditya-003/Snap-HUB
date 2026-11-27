import "server-only";

import { env } from "cloudflare:workers";
import type { AlbumRecord } from "@/lib/data";
import {
  checkDriveRefreshGrant,
  createDriveGrantHealth,
  driveConnectionStatus,
  failedGrantError,
  type StoredDriveGrant,
} from "@/lib/google-drive-grant";
import { SAMPLE_OBJECT_PREFIX, sampleMediaResponse } from "@/lib/sample-media";
import { getSessionSecret } from "@/lib/security";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const FOLDER_MIME_TYPE = "application/vnd.google-apps.folder";
const CONNECTION_ID = "primary";

type DriveConnectionRow = {
  encrypted_refresh_token: string;
  email: string;
  root_folder_id: string;
  created_at: number;
  updated_at: number;
};

type DriveTokenResponse = {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  error?: string;
  error_description?: string;
};

type DriveFile = { id: string; name?: string; size?: string; mimeType?: string };

// The grant-health checker owns the shared access-token cache. `verify`
// always exercises the stored refresh grant (the status path), while
// `accessTokenHealth` may reuse a still-fresh minted token for real Drive API
// calls — the refresh path recovers when a cached token dies early.
const grantHealth = createDriveGrantHealth({
  checkGrant: (refreshToken) =>
    checkDriveRefreshGrant({
      clientId: env.GOOGLE_CLIENT_ID,
      clientSecret: env.GOOGLE_CLIENT_SECRET,
      refreshToken,
    }),
});

// The browser smoke suite launches the local Worker with SNAP_HUB_FAKE_DRIVE=1
// so uploads, reads, and deletes stay inside the test runtime instead of
// reaching Google. The flag alone is never enough: fake mode also requires a
// loopback request URL, so a Worker accidentally deployed with the flag set
// still uses real Google Drive for real traffic.
function fakeDriveEnabled(request: Request | undefined) {
  if (env.SNAP_HUB_FAKE_DRIVE !== "1" || !request) return false;
  try {
    const { hostname } = new URL(request.url);
    return hostname === "localhost" || hostname === "127.0.0.1"
      || hostname === "[::1]" || hostname === "::1" || hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

function base64Bytes(value: string) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

// Tiny real fixtures so every advertised content type still decodes in a
// browser: a 1x1 PNG plus ffmpeg-generated 8x8 JPEG/GIF/WebP images and a 1s
// 64x64 H.264 clip that actually plays in the media viewer.
const FAKE_PNG_BYTES = base64Bytes(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
);
const FAKE_JPEG_BYTES = base64Bytes(
  "/9j/4AAQSkZJRgABAgAAAQABAAD//gAPTGF2YzYzLjEuMTAxAP/bAEMACAQEBAQEBQUFBQUFBgYGBgYGBgYGBgYGBgcHBwgICAcHBwYGBwcICAgICQkJCAgICAkJCgoKDAwLCw4ODhERFP/EAEwAAQEAAAAAAAAAAAAAAAAAAAAHAQEBAAAAAAAAAAAAAAAAAAAFBhABAAAAAAAAAAAAAAAAAAAAABEBAAAAAAAAAAAAAAAAAAAAAP/AABEIAAgACAMBIgACEQADEQD/2gAMAwEAAhEDEQA/AJKAJX7/2Q==",
);
const FAKE_GIF_BYTES = base64Bytes(
  "R0lGODlhCAAIAPcfMQAAACQAAEgAAGwAAJAAALQAANgAAPwAAAAkACQkAEgkAGwkAJAkALQkANgkAPwkAABIACRIAEhIAGxIAJBIALRIANhIAPxIAABsACRsAEhsAGxsAJBsALRsANhsAPxsAACQACSQAEiQAGyQAJCQALSQANiQAPyQAAC0ACS0AEi0AGy0AJC0ALS0ANi0APy0AADYACTYAEjYAGzYAJDYALTYANjYAPzYAAD8ACT8AEj8AGz8AJD8ALT8ANj8APz8AAAAVSQAVUgAVWwAVZAAVbQAVdgAVfwAVQAkVSQkVUgkVWwkVZAkVbQkVdgkVfwkVQBIVSRIVUhIVWxIVZBIVbRIVdhIVfxIVQBsVSRsVUhsVWxsVZBsVbRsVdhsVfxsVQCQVSSQVUiQVWyQVZCQVbSQVdiQVfyQVQC0VSS0VUi0VWy0VZC0VbS0Vdi0Vfy0VQDYVSTYVUjYVWzYVZDYVbTYVdjYVfzYVQD8VST8VUj8VWz8VZD8VbT8Vdj8Vfz8VQAAqiQAqkgAqmwAqpAAqrQAqtgAqvwAqgAkqiQkqkgkqmwkqpAkqrQkqtgkqvwkqgBIqiRIqkhIqmxIqpBIqrRIqthIqvxIqgBsqiRsqkhsqmxsqpBsqrRsqthsqvxsqgCQqiSQqkiQqmyQqpCQqrSQqtiQqvyQqgC0qiS0qki0qmy0qpC0qrS0qti0qvy0qgDYqiTYqkjYqmzYqpDYqrTYqtjYqvzYqgD8qiT8qkj8qmz8qpD8qrT8qtj8qvz8qgAA/yQA/0gA/2wA/5AA/7QA/9gA//wA/wAk/yQk/0gk/2wk/5Ak/7Qk/9gk//wk/wBI/yRI/0hI/2xI/5BI/7RI/9hI//xI/wBs/yRs/0hs/2xs/5Bs/7Rs/9hs//xs/wCQ/ySQ/0iQ/2yQ/5CQ/7SQ/9iQ//yQ/wC0/yS0/0i0/2y0/5C0/7S0/9i0//y0/wDY/yTY/0jY/2zY/5DY/7TY/9jY//zY/wD8/yT8/0j8/2z8/5D8/7T8/9j8//z8/yH/C05FVFNDQVBFMi4wAwEAAAAh+QQEBAAfACwAAAAACAAIAAAIGQAJDBBIcMDAgwQLFkSIUOFBhgkhGnRIICAAOw==",
);
const FAKE_WEBP_BYTES = base64Bytes(
  "UklGRjgAAABXRUJQVlA4ICwAAACQAQCdASoIAAgAAgA0JaACdLoAA5gA/vh8s90ACn7P/6En/xNn/E2fAAAAAA==",
);
const FAKE_MP4_BYTES = base64Bytes(
  "AAAAIGZ0eXBpc29tAAACAGlzb21pc28yYXZjMW1wNDEAAAPtbW9vdgAAAGxtdmhkAAAAAAAAAAAAAAAAAAAD6AAAA+gAAQAAAQAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAgAAAxh0cmFrAAAAXHRraGQAAAADAAAAAAAAAAAAAAABAAAAAAAAA+gAAAAAAAAAAAAAAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAABAAAAAAAAAAAAAAAAAABAAAAAAEAAAABAAAAAAAAkZWR0cwAAABxlbHN0AAAAAAAAAAEAAAPoAAAIAAABAAAAAAKQbWRpYQAAACBtZGhkAAAAAAAAAAAAAAAAAAA8AAAAPABVxAAAAAAALWhkbHIAAAAAAAAAAHZpZGUAAAAAAAAAAAAAAABWaWRlb0hhbmRsZXIAAAACO21pbmYAAAAUdm1oZAAAAAEAAAAAAAAAAAAAACRkaW5mAAAAHGRyZWYAAAAAAAAAAQAAAAx1cmwgAAAAAQAAAftzdGJsAAAAv3N0c2QAAAAAAAAAAQAAAK9hdmMxAAAAAAAAAAEAAAAAAAAAAAAAAAAAAAAAAEAAQABIAAAASAAAAAAAAAABFExhdmM2My4xLjEwMSBsaWJ4MjY0AAAAAAAAAAAAAAAAGP//AAAANWF2Y0MBZAAK/+EAGGdkAAqs2UQmwEQAAAMABAAAAwB4PEiWWAEABmjr48siwP34+AAAAAAQcGFzcAAAAAEAAAABAAAAFGJ0cnQAAAAAAAAc8AAAAAAAAAAYc3R0cwAAAAAAAAABAAAADwAABAAAAAAUc3RzcwAAAAAAAAABAAAAAQAAAIhjdHRzAAAAAAAAAA8AAAABAAAIAAAAAAEAABQAAAAAAQAACAAAAAABAAAAAAAAAAEAAAQAAAAAAQAAFAAAAAABAAAIAAAAAAEAAAAAAAAAAQAABAAAAAABAAAUAAAAAAEAAAgAAAAAAQAAAAAAAAABAAAEAAAAAAEAAAwAAAAAAQAABAAAAAAcc3RzYwAAAAAAAAABAAAAAQAAAA8AAAABAAAAUHN0c3oAAAAAAAAAAAAAAA8AAALXAAAADgAAAAwAAAAMAAAADAAAABQAAAAOAAAADAAAAAwAAAAUAAAADgAAAAwAAAAMAAAAFQAAAAwAAAAUc3RjbwAAAAAAAAABAAAEHQAAAGF1ZHRhAAAAWW1ldGEAAAAAAAAAIWhkbHIAAAAAAAAAAG1kaXJhcHBsAAAAAAAAAAAAAAAALGlsc3QAAAAkqXRvbwAAABxkYXRhAAAAAQAAAABMYXZmNjMuMS4xMDEAAAAIZnJlZQAAA6ZtZGF0AAACrgYF//+q3EXpvebZSLeWLNgg2SPu73gyNjQgLSBjb3JlIDE2NSByMzIyMyAwNDgwY2IwIC0gSC4yNjQvTVBFRy00IEFWQyBjb2RlYyAtIENvcHlsZWZ0IDIwMDMtMjAyNSAtIGh0dHA6Ly93d3cudmlkZW9sYW4ub3JnL3gyNjQuaHRtbCAtIG9wdGlvbnM6IGNhYmFjPTEgcmVmPTMgZGVibG9jaz0xOjA6MCBhbmFseXNlPTB4MzoweDExMyBtZT1oZXggc3VibWU9NyBwc3k9MSBwc3lfcmQ9MS4wMDowLjAwIG1peGVkX3JlZj0xIG1lX3JhbmdlPTE2IGNocm9tYV9tZT0xIHRyZWxsaXM9MSA4eDhkY3Q9MSBjcW09MCBkZWFkem9uZT0yMSwxMSBmYXN0X3Bza2lwPTEgY2hyb21hX3FwX29mZnNldD0tMiB0aHJlYWRzPTIgbG9va2FoZWFkX3RocmVhZHM9MSBzbGljZWRfdGhyZWFkcz0wIG5yPTAgZGVjaW1hdGU9MSBpbnRlcmxhY2VkPTAgYmx1cmF5X2NvbXBhdD0wIGNvbnN0cmFpbmVkX2ludHJhPTAgYmZyYW1lcz0zIGJfcHlyYW1pZD0yIGJfYWRhcHQ9MSBiX2JpYXM9MCBkaXJlY3Q9MSB3ZWlnaHRiPTEgb3Blbl9nb3A9MCB3ZWlnaHRwPTIga2V5aW50PTI1MCBrZXlpbnRfbWluPTE1IHNjZW5lY3V0PTQwIGludHJhX3JlZnJlc2g9MCByY19sb29rYWhlYWQ9NDAgcmM9Y3JmIG1idHJlZT0xIGNyZj0yMy4wIHFjb21wPTAuNjAgcXBtaW49MCBxcG1heD02OSBxcHN0ZXA9NCBpcF9yYXRpbz0xLjQwIGFxPTE6MS4wMACAAAAAIWWIhAAQ//73gb8yy2Q/qslx+ed8UPyh0qwairOl4CszsQAAAApBmiRsQ//+qZ00AAAACEGeQniG/wd9AAAACAGeYXRC/wm4AAAACAGeY2pC/wm5AAAAEEGaaEmoQWiZTAh///6pnTUAAAAKQZ6GRREsN/8HfQAAAAgBnqV0Qv8JuQAAAAgBnqdqQv8JuAAAABBBmqxJqEFsmUwIb//+p4+IAAAACkGeykUVLDf/B30AAAAIAZ7pdEL/CbgAAAAIAZ7rakL/CbgAAAARQZruSahBbJlMFEwv//6M02EAAAAIAZ8NakL/Cbk=",
);

// Served bytes always match the advertised content type; unknown types fall
// back to the PNG so thumbnails never break.
function fakeMedia(contentType: string) {
  if (contentType.startsWith("video/")) return { contentType: "video/mp4", body: FAKE_MP4_BYTES };
  if (contentType === "image/jpeg") return { contentType, body: FAKE_JPEG_BYTES };
  if (contentType === "image/gif") return { contentType, body: FAKE_GIF_BYTES };
  if (contentType === "image/webp") return { contentType, body: FAKE_WEBP_BYTES };
  return { contentType: "image/png", body: FAKE_PNG_BYTES };
}

export class GoogleDriveError extends Error {
  constructor(message: string, public readonly status = 502) {
    super(message);
    this.name = "GoogleDriveError";
  }
}

function bytesToBase64Url(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string) {
  const normalized = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function encryptionKey() {
  const material = await crypto.subtle.digest(
    "SHA-256",
    encoder.encode(`snap-hub-google-drive:${getSessionSecret()}`),
  );
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

async function encryptRefreshToken(token: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await encryptionKey(), encoder.encode(token));
  return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

async function decryptRefreshToken(value: string) {
  const [ivValue, encryptedValue] = value.split(".");
  if (!ivValue || !encryptedValue) throw new GoogleDriveError("Google Drive connection is invalid.", 500);
  try {
    const decrypted = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: base64UrlToBytes(ivValue) },
      await encryptionKey(),
      base64UrlToBytes(encryptedValue),
    );
    return decoder.decode(decrypted);
  } catch {
    throw new GoogleDriveError("Google Drive must be connected again.", 503);
  }
}

async function oauthSigningKey() {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(getSessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function createGoogleOAuthState() {
  const nonce = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(18)));
  const expires = String(Date.now() + 10 * 60 * 1000);
  const value = `drive.${nonce}.${expires}`;
  const signature = await crypto.subtle.sign("HMAC", await oauthSigningKey(), encoder.encode(value));
  return `${value}.${bytesToBase64Url(new Uint8Array(signature))}`;
}

export async function verifyGoogleOAuthState(value: string | undefined) {
  if (!value) return false;
  const [prefix, nonce, expires, signature] = value.split(".");
  if (prefix !== "drive" || !nonce || !expires || !signature || Number(expires) < Date.now()) return false;
  return crypto.subtle.verify(
    "HMAC",
    await oauthSigningKey(),
    base64UrlToBytes(signature),
    encoder.encode(`${prefix}.${nonce}.${expires}`),
  );
}

export function googleDriveConfigured() {
  return Boolean(env.GOOGLE_CLIENT_ID?.trim() && env.GOOGLE_CLIENT_SECRET?.trim());
}

export function googleOAuthRedirectUri(origin: string) {
  return `${origin}/api/admin/google-drive/callback`;
}

export function googleOAuthAuthorizationUrl(origin: string, state: string) {
  if (!googleDriveConfigured()) throw new GoogleDriveError("Google Drive OAuth is not configured.", 503);
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.search = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    redirect_uri: googleOAuthRedirectUri(origin),
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: `openid email ${DRIVE_SCOPE}`,
    state,
  }).toString();
  return url.toString();
}

export async function exchangeGoogleOAuthCode(code: string, origin: string) {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: "authorization_code",
      redirect_uri: googleOAuthRedirectUri(origin),
    }),
  });
  const token = await response.json() as DriveTokenResponse;
  if (!response.ok || !token.access_token || !token.refresh_token) {
    throw new GoogleDriveError(token.error_description || "Google Drive did not return offline access.", 502);
  }
  const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
    headers: { Authorization: `Bearer ${token.access_token}` },
  });
  const profile = await profileResponse.json() as { email?: string };
  if (!profileResponse.ok || !profile.email) throw new GoogleDriveError("Could not read the connected Google account.", 502);
  return { accessToken: token.access_token, refreshToken: token.refresh_token, email: profile.email };
}

async function getConnectionRow() {
  return env.DB.prepare(
    "SELECT encrypted_refresh_token, email, root_folder_id, created_at, updated_at FROM google_drive_connections WHERE id = ? LIMIT 1",
  ).bind(CONNECTION_ID).first<DriveConnectionRow>();
}

// Wraps a connection row for the grant-health checker. A stored refresh token
// that can no longer be decrypted (for example after SESSION_SECRET changed)
// reports "expired" because only reconnecting can repair it; transient
// token-endpoint failures report "unverified" instead.
function storedGrant(connection: DriveConnectionRow): StoredDriveGrant {
  return {
    connectionUpdatedAt: connection.updated_at,
    decryptRefreshToken: () => decryptRefreshToken(connection.encrypted_refresh_token),
  };
}

async function accessToken() {
  if (!googleDriveConfigured()) throw new GoogleDriveError("Google Drive OAuth is not configured.", 503);
  const connection = await getConnectionRow();
  if (!connection) throw new GoogleDriveError("Connect Google Drive from the host dashboard first.", 503);
  const grant = await grantHealth.accessTokenHealth(storedGrant(connection));
  if (grant.outcome !== "healthy") {
    const failure = failedGrantError(grant);
    throw new GoogleDriveError(failure.message, failure.status);
  }
  return grant.accessToken;
}

async function driveJson<T>(url: string, init: RequestInit = {}, suppliedAccessToken?: string) {
  const token = suppliedAccessToken ?? await accessToken();
  const response = await fetch(url, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
  });
  if (!response.ok) {
    if (response.status === 401 || response.status === 403) {
      throw new GoogleDriveError("Google Drive authorization must be renewed.", 503);
    }
    if (response.status === 404) throw new GoogleDriveError("The Google Drive item was not found.", 404);
    throw new GoogleDriveError("Google Drive could not complete the request.", 502);
  }
  if (response.status === 204) return undefined as T;
  return response.json() as Promise<T>;
}

async function createFolder(name: string, parentId: string | null, appProperties: Record<string, string>, token?: string) {
  return driveJson<DriveFile>("https://www.googleapis.com/drive/v3/files?fields=id,name", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      name,
      mimeType: FOLDER_MIME_TYPE,
      ...(parentId ? { parents: [parentId] } : {}),
      appProperties,
    }),
  }, token);
}

async function findOrCreateRootFolder(token: string) {
  const query = "appProperties has { key='snapHubRoot' and value='true' } and trashed=false";
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.search = new URLSearchParams({ q: query, spaces: "drive", pageSize: "1", fields: "files(id,name)" }).toString();
  const result = await driveJson<{ files?: DriveFile[] }>(url.toString(), {}, token);
  const existing = result.files?.[0];
  if (existing?.id) return existing.id;
  const created = await createFolder("Snap HUB", null, { snapHubRoot: "true" }, token);
  if (!created.id) throw new GoogleDriveError("Google Drive did not create the Snap HUB folder.");
  return created.id;
}

export async function saveGoogleDriveConnection(refreshToken: string, accessTokenValue: string, email: string) {
  const previous = await getConnectionRow();
  if (previous && previous.email.toLowerCase() !== email.toLowerCase()) {
    const eventWithDriveMedia = await env.DB.prepare("SELECT 1 FROM albums WHERE drive_folder_id IS NOT NULL LIMIT 1").first();
    if (eventWithDriveMedia) {
      throw new GoogleDriveError("Reconnect the Google account already associated with Snap HUB.", 409);
    }
  }
  const rootFolderId = await findOrCreateRootFolder(accessTokenValue);
  const encryptedRefreshToken = await encryptRefreshToken(refreshToken);
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO google_drive_connections (id, encrypted_refresh_token, email, root_folder_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET encrypted_refresh_token = excluded.encrypted_refresh_token,
       email = excluded.email, root_folder_id = excluded.root_folder_id, updated_at = excluded.updated_at`,
  ).bind(CONNECTION_ID, encryptedRefreshToken, email, rootFolderId, now, now).run();
  grantHealth.seedCache({ token: accessTokenValue, expiresAt: now + 50 * 60 * 1000, connectionUpdatedAt: now });
  return { email, rootFolderId, rootFolderUrl: driveFolderUrl(rootFolderId) };
}

export function driveFolderUrl(folderId: string) {
  return `https://drive.google.com/drive/folders/${encodeURIComponent(folderId)}`;
}

export async function getGoogleDriveStatus() {
  const configured = googleDriveConfigured();
  const connection = await getConnectionRow();
  // Only probe the grant when a refresh can actually run: without the OAuth
  // client settings the dashboard must show setup guidance instead. The probe
  // always posts the stored refresh token to Google — a cached access token
  // must not hide a grant that was revoked since the token was minted.
  const grant = configured && connection ? await grantHealth.verify(storedGrant(connection)) : null;
  const status = driveConnectionStatus({
    configured,
    connection: connection ? { email: connection.email, rootFolderId: connection.root_folder_id } : null,
    grant,
  });
  return {
    ...status,
    rootFolderUrl: status.rootFolderId ? driveFolderUrl(status.rootFolderId) : null,
  };
}

export async function deleteDriveFile(fileId: string | null | undefined, request?: Request) {
  if (!fileId || fileId.startsWith(SAMPLE_OBJECT_PREFIX) || fakeDriveEnabled(request)) return;
  const token = await accessToken();
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok && response.status !== 404) throw new GoogleDriveError("Could not remove the item from Google Drive.");
}

export type EventDriveFolders = {
  eventFolderId: string;
  photosFolderId: string;
  videosFolderId: string;
  guestUploadsFolderId: string;
  folderUrl: string;
};

export async function createEventDriveFolders(albumId: string, title: string, request?: Request): Promise<EventDriveFolders> {
  if (fakeDriveEnabled(request)) {
    return {
      eventFolderId: "fake-drive-event-folder",
      photosFolderId: "fake-drive-photos-folder",
      videosFolderId: "fake-drive-videos-folder",
      guestUploadsFolderId: "fake-drive-guest-uploads-folder",
      folderUrl: "",
    };
  }
  const connection = await getConnectionRow();
  if (!connection) throw new GoogleDriveError("Connect Google Drive from the host dashboard first.", 503);
  const eventFolder = await createFolder(title.slice(0, 180), connection.root_folder_id, { snapHubEventId: albumId, snapHubType: "event" });
  if (!eventFolder.id) throw new GoogleDriveError("Could not create the event folder in Google Drive.");
  try {
    const [photos, videos, guestUploads] = await Promise.all([
      createFolder("Photos", eventFolder.id, { snapHubEventId: albumId, snapHubCategory: "photos" }),
      createFolder("Videos", eventFolder.id, { snapHubEventId: albumId, snapHubCategory: "videos" }),
      createFolder("Guest Uploads", eventFolder.id, { snapHubEventId: albumId, snapHubCategory: "guest-uploads" }),
      createFolder("Highlights", eventFolder.id, { snapHubEventId: albumId, snapHubCategory: "highlights" }),
    ]);
    if (!photos.id || !videos.id || !guestUploads.id) throw new GoogleDriveError("Could not create all event folders in Google Drive.");
    return {
      eventFolderId: eventFolder.id,
      photosFolderId: photos.id,
      videosFolderId: videos.id,
      guestUploadsFolderId: guestUploads.id,
      folderUrl: driveFolderUrl(eventFolder.id),
    };
  } catch (error) {
    await deleteDriveFile(eventFolder.id, request).catch(() => undefined);
    throw error;
  }
}

export async function ensureEventDriveFolders(album: AlbumRecord, request?: Request) {
  if (album.drive_folder_id && album.drive_photos_folder_id && album.drive_videos_folder_id && album.drive_guest_uploads_folder_id) {
    return {
      eventFolderId: album.drive_folder_id,
      photosFolderId: album.drive_photos_folder_id,
      videosFolderId: album.drive_videos_folder_id,
      guestUploadsFolderId: album.drive_guest_uploads_folder_id,
      folderUrl: driveFolderUrl(album.drive_folder_id),
    } satisfies EventDriveFolders;
  }
  const folders = await createEventDriveFolders(album.id, album.title, request);
  try {
    await env.DB.prepare(
      `UPDATE albums SET drive_folder_id = ?, drive_photos_folder_id = ?, drive_videos_folder_id = ?,
        drive_guest_uploads_folder_id = ? WHERE id = ?`,
    ).bind(folders.eventFolderId, folders.photosFolderId, folders.videosFolderId, folders.guestUploadsFolderId, album.id).run();
  } catch {
    await deleteDriveFile(folders.eventFolderId, request).catch(() => undefined);
    throw new GoogleDriveError("The Google Drive folders were created, but the event could not be updated.", 500);
  }
  return folders;
}

function safeDriveFilename(filename: string) {
  return filename.replace(/[\\/\u0000-\u001f]/gu, "-").trim().slice(0, 180) || "Snap HUB memory";
}

export async function uploadDriveMedia(file: File, folderId: string, metadata: { albumId: string; photoId: string; source: string }, request?: Request) {
  if (fakeDriveEnabled(request)) {
    return { id: `fake-drive-${metadata.photoId}`, name: safeDriveFilename(file.name), size: String(file.size), mimeType: file.type };
  }
  const token = await accessToken();
  const initiate = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id,name,size,mimeType", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json; charset=UTF-8",
      "X-Upload-Content-Type": file.type,
      "X-Upload-Content-Length": String(file.size),
    },
    body: JSON.stringify({
      name: safeDriveFilename(file.name),
      mimeType: file.type,
      parents: [folderId],
      appProperties: {
        snapHubAlbumId: metadata.albumId,
        snapHubPhotoId: metadata.photoId,
        snapHubSource: metadata.source,
      },
    }),
  });
  const location = initiate.headers.get("location");
  if (!initiate.ok || !location) throw new GoogleDriveError("Could not start the Google Drive upload.");
  const uploadUrl = new URL(location);
  if (uploadUrl.protocol !== "https:" || !uploadUrl.hostname.endsWith(".googleapis.com")) {
    throw new GoogleDriveError("Google Drive returned an invalid upload destination.");
  }
  const uploaded = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": file.type,
      "Content-Length": String(file.size),
    },
    body: file,
  });
  if (!uploaded.ok) throw new GoogleDriveError("Google Drive did not finish the upload.");
  const result = await uploaded.json() as DriveFile;
  if (!result.id) throw new GoogleDriveError("Google Drive did not return the uploaded file.");
  return result;
}

export async function driveMediaResponse(fileId: string, request: Request, options: {
  contentType: string;
  filename: string;
  download?: boolean;
  cacheControl?: string;
}) {
  // Reserved "sample:" keys are local-dev fixtures (`npm run sample:gallery`).
  // They can never be real Drive IDs, so nothing else changes: deployed and
  // non-local requests still stream originals from Google Drive below.
  const sample = await sampleMediaResponse(fileId, request, options);
  if (sample) return sample;
  if (fakeDriveEnabled(request)) {
    const media = fakeMedia(options.contentType);
    const headers = new Headers({
      "Content-Type": media.contentType,
      "Cache-Control": options.cacheControl ?? "private, max-age=3600",
      "Accept-Ranges": "bytes",
      "Content-Disposition": `${options.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(options.filename)}`,
    });
    const range = request.headers.get("range")?.match(/^bytes=(\d*)-(\d*)$/i);
    if (range && (range[1] || range[2])) {
      const total = media.body.byteLength;
      const start = range[1] ? Number(range[1]) : Math.max(0, total - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(total - 1, Number(range[2])) : total - 1;
      if (start >= 0 && start <= end && end < total) {
        headers.set("Content-Range", `bytes ${start}-${end}/${total}`);
        headers.set("Content-Length", String(end - start + 1));
        return new Response(media.body.slice(start, end + 1), { status: 206, headers });
      }
      return new Response("Range not satisfiable", { status: 416, headers });
    }
    headers.set("Content-Length", String(media.body.byteLength));
    return new Response(media.body, { headers });
  }
  const token = await accessToken();
  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const range = request.headers.get("range");
  if (range) headers.Range = range;
  const response = await fetch(`https://www.googleapis.com/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`, { headers });
  if (response.status === 404) return new Response("Not found", { status: 404 });
  if (!response.ok && response.status !== 206) throw new GoogleDriveError("Could not read this item from Google Drive.");
  const outgoing = new Headers({
    "Content-Type": response.headers.get("content-type") || options.contentType,
    "Cache-Control": options.cacheControl ?? "private, max-age=3600",
    "Accept-Ranges": response.headers.get("accept-ranges") || "bytes",
    "Content-Disposition": `${options.download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(options.filename)}`,
  });
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = response.headers.get(name);
    if (value) outgoing.set(name, value);
  }
  return new Response(response.body, { status: response.status, headers: outgoing });
}
