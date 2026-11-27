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

export const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;

export type UploadSelection = {
  files: File[];
  keys: string[];
  saved: Set<string>;
};

export function prepareUploads(body: FormData, files: File[], previous: UploadSelection | null) {
  const selection = previous && files.length === previous.files.length
    && files.every((file, index) => file === previous.files[index])
    ? previous
    : { files, keys: files.map(() => crypto.randomUUID()), saved: new Set<string>() };
  body.delete("photos");
  let count = 0;
  for (const [index, file] of files.entries()) {
    const key = selection.keys[index];
    if (selection.saved.has(key)) continue;
    body.append("photos", file);
    body.append("uploadKeys", key);
    count += 1;
  }
  return { selection, count, alreadySaved: files.length - count };
}

export function describeNames(names: string[], max = 3) {
  const shown = names.slice(0, max).join(", ");
  return names.length > max ? `${shown} +${names.length - max} more` : shown;
}

export function describeRejected(rejected: MediaRejection[], max = 3) {
  return describeNames(rejected.map((item) => `${item.filename} (${item.reason})`), max);
}

export function readUploadKeys(body: FormData, files: File[]) {
  const keys = body.getAll("uploadKeys");
  if (!keys.length) return new Map<File, string>();
  if (keys.length !== files.length || new Set(keys).size !== keys.length) return null;
  const byFile = new Map<File, string>();
  for (const [index, key] of keys.entries()) {
    if (typeof key !== "string" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(key)) return null;
    byFile.set(files[index], key);
  }
  return byFile;
}

type UploadScope = { albumId: string; source: "guest" | "host" };
export type SavedUploadPhoto = {
  id: string; filename: string; size: number; moderationStatus: string; uploadKey?: string;
};
export type UploadOutcome = { photos: SavedUploadPhoto[]; inserted: number };

async function uploadPhotoId(scope: UploadScope, key: string) {
  const value = new TextEncoder().encode(JSON.stringify([scope.albumId, scope.source, key]));
  const hash = await crypto.subtle.digest("SHA-256", value);
  return "upload-" + Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function savedPhoto(db: D1Database, scope: UploadScope, id: string) {
  return db.prepare(
    "SELECT filename, size, moderation_status FROM photos WHERE id = ? AND album_id = ? AND source = ?",
  ).bind(id, scope.albumId, scope.source).first<{ filename: string; size: number; moderation_status: string }>();
}

export async function saveMediaFiles(
  db: D1Database,
  files: File[],
  scope: UploadScope,
  keys: ReadonlyMap<File, string>,
  save: (file: File, photoId: string) => Promise<string>,
  outcome: UploadOutcome = { photos: [], inserted: 0 },
): Promise<UploadOutcome> {
  for (const file of files) {
    const uploadKey = keys.get(file);
    const id = uploadKey ? await uploadPhotoId(scope, uploadKey) : crypto.randomUUID();
    let prior = uploadKey ? await savedPhoto(db, scope, id) : null;
    let moderationStatus: string;
    if (!prior) {
      try {
        moderationStatus = await save(file, id);
        outcome.photos.push({ id, filename: file.name, size: file.size, moderationStatus, uploadKey });
        outcome.inserted += 1;
        continue;
      } catch (error) {
        // A concurrent retry can win the primary-key insert. The save callback
        // has already discarded its own Drive object in that case.
        prior = uploadKey ? await savedPhoto(db, scope, id) : null;
        if (!prior) throw error;
      }
    }
    if (prior.filename !== file.name || prior.size !== file.size) {
      throw new Error("Upload identity already belongs to another file");
    }
    outcome.photos.push({ id, filename: file.name, size: file.size, moderationStatus: prior.moderation_status, uploadKey });
  }
  return outcome;
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
