const allowedTypes = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif", "image/heic", "image/heif",
  "video/mp4", "video/quicktime", "video/webm",
]);
const allowedExtensions = new Set(["jpg", "jpeg", "png", "webp", "gif", "heic", "heif", "mp4", "mov", "webm"]);

export function isAllowedMedia(file: File) {
  const extension = file.name.toLowerCase().split(".").pop() ?? "";
  return allowedTypes.has(file.type.toLowerCase()) && allowedExtensions.has(extension);
}

function startsWith(bytes: Uint8Array, signature: number[]) {
  return signature.every((byte, index) => bytes[index] === byte);
}

function ascii(bytes: Uint8Array, start: number, length: number) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

export const MAX_MEDIA_FILE_SIZE = 75 * 1024 * 1024;

export type MediaRejection = { filename: string; reason: string };

// Retries of an upload that committed before its response was lost must not
// create duplicate gallery entries, so a matching row inside this window is
// reported as already saved instead of being inserted again.
export const UPLOAD_RETRY_WINDOW_MS = 10 * 60 * 1000;

// How many saves of each `filename:size` key the browser already knows about —
// the upload form posts this back so the server can line retried files up with
// the rows an earlier attempt committed.
export function parseKnownSaved(raw: FormDataEntryValue | null): Map<string, number> {
  const known = new Map<string, number>();
  if (typeof raw !== "string" || !raw) return known;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "number" && Number.isFinite(value) && value > 0) {
        known.set(key, Math.floor(value));
      }
    }
  } catch { /* Treat malformed input as "no known saves". */ }
  return known;
}

export function mediaUploadKey(name: string, size?: number) {
  return `${name}:${size ?? ""}`;
}

// Removes up to `savedCounts[key]` files per upload key, in order — a batch
// may hold distinct files that share a name and size, and only the ones the
// server confirmed should be skipped on retry.
export function filterUnsentFiles<T extends { name: string; size: number }>(files: T[], savedCounts: ReadonlyMap<string, number>): T[] {
  const remaining = new Map(savedCounts);
  return files.filter((file) => {
    const skipped = remaining.get(mediaUploadKey(file.name, file.size)) ?? 0;
    if (!skipped) return true;
    remaining.set(mediaUploadKey(file.name, file.size), skipped - 1);
    return false;
  });
}

export type RecentUploadMatch = {
  albumId: string; filename: string; size: number; uploaderName: string; source: "guest" | "host";
};

// Returns the prior row occupying `position` in upload order for this file's
// key, or null when fewer prior rows exist — meaning this occurrence still
// needs to be inserted. Position is per-key across attempts (known saves plus
// earlier occurrences in this request), so distinct files that happen to share
// a name and size are matched with distinct rows instead of collapsing onto
// the newest one.
export async function findRecentUpload(db: D1Database, match: RecentUploadMatch, position: number) {
  const row = await db.prepare(
    `SELECT id, moderation_status FROM photos
     WHERE album_id = ? AND filename = ? AND size = ? AND uploader_name = ? AND source = ?
       AND moderation_status != 'rejected' AND created_at > ?
     ORDER BY created_at ASC LIMIT 1 OFFSET ?`,
  ).bind(match.albumId, match.filename, match.size, match.uploaderName, match.source,
    Date.now() - UPLOAD_RETRY_WINDOW_MS, position).first<{ id: string; moderation_status: string }>();
  return row ? { id: row.id, moderationStatus: row.moderation_status } : null;
}

export async function checkMediaFile(file: File): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (file.size > MAX_MEDIA_FILE_SIZE) return { ok: false, reason: "over 75 MB" };
  if (!isAllowedMedia(file)) return { ok: false, reason: "unsupported file type" };
  if (!(await hasValidMediaSignature(file))) return { ok: false, reason: "unrecognized file contents" };
  return { ok: true };
}

export async function splitMediaFiles(files: File[]): Promise<{ accepted: File[]; rejected: MediaRejection[] }> {
  const accepted: File[] = [];
  const rejected: MediaRejection[] = [];
  for (const file of files) {
    const check = await checkMediaFile(file);
    if (check.ok) accepted.push(file);
    else rejected.push({ filename: file.name, reason: check.reason });
  }
  return { accepted, rejected };
}

export async function hasValidMediaSignature(file: File) {
  if (!isAllowedMedia(file)) return false;
  const bytes = new Uint8Array(await file.slice(0, 32).arrayBuffer());
  const type = file.type.toLowerCase();
  if (type === "image/jpeg") return startsWith(bytes, [0xff, 0xd8, 0xff]);
  if (type === "image/png") return startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (type === "image/gif") return ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a";
  if (type === "image/webp") return ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP";
  if (type === "video/webm") return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
  if (type === "video/mp4" || type === "video/quicktime") return ascii(bytes, 4, 4) === "ftyp";
  if (type === "image/heic" || type === "image/heif") {
    const brand = ascii(bytes, 8, 4);
    return ascii(bytes, 4, 4) === "ftyp" && ["heic", "heix", "hevc", "hevx", "mif1", "msf1"].includes(brand);
  }
  return false;
}
