import assert from "node:assert/strict";
import { test } from "node:test";

// The upload routes split each batch with the pure helpers in lib/uploads.ts.
// They are exercised here with real File objects — no D1 or Drive mocking needed.
let uploads;
try {
  uploads = await import("../lib/uploads.ts");
} catch (error) {
  if (error?.code !== "ERR_UNKNOWN_FILE_EXTENSION") throw error;
}
const needsTypeStripping = uploads ? false : "requires Node >= 22.18 (or --experimental-strip-types) to import .ts modules";
const { checkMediaFile, splitMediaFiles, MAX_MEDIA_FILE_SIZE, filterUnsentFiles, findRecentUpload, mediaUploadKey, parseKnownSaved, UPLOAD_RETRY_WINDOW_MS } = uploads ?? {};

const PNG_HEADER = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_HEADER = [0xff, 0xd8, 0xff, 0xe0];

function png(name = "memory.png") {
  return new File([new Uint8Array([...PNG_HEADER, 1, 2, 3, 4])], name, { type: "image/png" });
}

function oversized(name = "clip.mp4") {
  const file = new File([new Uint8Array(8)], name, { type: "video/mp4" });
  // checkMediaFile inspects size before reading bytes, so a spoofed size is enough.
  Object.defineProperty(file, "size", { value: MAX_MEDIA_FILE_SIZE + 1 });
  return file;
}

test("a valid photo is accepted", { skip: needsTypeStripping }, async () => {
  assert.deepEqual(await checkMediaFile(png()), { ok: true });
  assert.deepEqual(await checkMediaFile(new File([new Uint8Array([...JPEG_HEADER, 0, 0])], "pic.jpg", { type: "image/jpeg" })), { ok: true });
});

test("an oversized file is rejected with a size reason", { skip: needsTypeStripping }, async () => {
  assert.deepEqual(await checkMediaFile(oversized()), { ok: false, reason: "over 75 MB" });
});

test("an unsupported type is rejected before its signature is read", { skip: needsTypeStripping }, async () => {
  assert.deepEqual(await checkMediaFile(new File(["hello"], "notes.txt", { type: "text/plain" })), { ok: false, reason: "unsupported file type" });
  // Even with a media MIME type, a disallowed extension is still rejected.
  assert.deepEqual(await checkMediaFile(new File([new Uint8Array(PNG_HEADER)], "fake.png.exe", { type: "image/png" })), { ok: false, reason: "unsupported file type" });
});

test("a spoofed media file is rejected by its signature", { skip: needsTypeStripping }, async () => {
  assert.deepEqual(await checkMediaFile(new File(["not a real jpeg"], "photo.jpg", { type: "image/jpeg" })), { ok: false, reason: "unrecognized file contents" });
});

test("a mixed batch is split into accepted files and per-file rejections", { skip: needsTypeStripping }, async () => {
  const batch = [png("good.png"), oversized("huge.mov"), new File(["plain text"], "notes.txt", { type: "text/plain" })];
  const { accepted, rejected } = await splitMediaFiles(batch);
  assert.deepEqual(accepted.map((file) => file.name), ["good.png"]);
  assert.deepEqual(rejected, [
    { filename: "huge.mov", reason: "over 75 MB" },
    { filename: "notes.txt", reason: "unsupported file type" },
  ]);
});

test("a fully rejected batch explains every failure", { skip: needsTypeStripping }, async () => {
  const { accepted, rejected } = await splitMediaFiles([
    oversized("huge.mov"),
    new File(["plain text"], "notes.txt", { type: "text/plain" }),
  ]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 2);
});

test("a retry that filters out confirmed saves only resends the rejected files", { skip: needsTypeStripping }, async () => {
  const batch = [png("good.png"), oversized("huge.mov"), new File(["plain text"], "notes.txt", { type: "text/plain" })];
  const { accepted, rejected } = await splitMediaFiles(batch);
  // The guest view counts confirmed uploads per `filename:size` key from the API response.
  const saved = new Map(accepted.map((file) => [mediaUploadKey(file.name, file.size), 1]));
  const retry = filterUnsentFiles(batch, saved);
  assert.deepEqual(retry.map((file) => file.name), ["huge.mov", "notes.txt"]);
  const secondAttempt = await splitMediaFiles(retry);
  assert.equal(secondAttempt.accepted.length, 0);
  assert.deepEqual(secondAttempt.rejected, rejected);
});

test("two distinct files with the same name and size are not both skipped on retry", { skip: needsTypeStripping }, () => {
  const first = png("duplicate.png");
  const second = new File([new Uint8Array([...PNG_HEADER, 9, 9, 9, 9])], "duplicate.png", { type: "image/png" });
  assert.equal(first.size, second.size);
  // Only one was confirmed saved, so exactly one matching file must still send.
  const saved = new Map([[mediaUploadKey("duplicate.png", first.size), 1]]);
  assert.deepEqual(filterUnsentFiles([first, second], saved), [second]);
  // If both were confirmed (e.g. a retried batch that committed twice), both are skipped.
  const savedTwice = new Map([[mediaUploadKey("duplicate.png", first.size), 2]]);
  assert.deepEqual(filterUnsentFiles([first, second], savedTwice), []);
  // A different size under the same name is a different file and still sends.
  const other = new File([new Uint8Array([...PNG_HEADER, 0])], "duplicate.png", { type: "image/png" });
  assert.deepEqual(filterUnsentFiles([first, other], saved), [other]);
});

// Minimal D1 stand-in that applies the same WHERE/ORDER/LIMIT-OFFSET semantics
// as the dedupe query in lib/uploads.ts.
function fakeD1(rows) {
  return {
    prepare: () => ({
      bind: (albumId, filename, size, uploaderName, source, cutoff, offset = 0) => ({
        first: async () => rows
          .filter((row) => row.album_id === albumId && row.filename === filename && row.size === size
            && row.uploader_name === uploaderName && row.source === source
            && row.moderation_status !== "rejected" && row.created_at > cutoff)
          .sort((a, b) => a.created_at - b.created_at)[offset] ?? null,
      }),
    }),
  };
}

const match = { albumId: "album-1", filename: "good.png", size: 12, uploaderName: "Guest", source: "guest" };

function savedRow(id, ageMs = 60_000) {
  return { id, moderation_status: "pending", album_id: "album-1", filename: "good.png", size: 12, uploader_name: "Guest", source: "guest", created_at: Date.now() - ageMs };
}

test("a just-saved upload is deduplicated instead of inserted again", { skip: needsTypeStripping }, async () => {
  assert.deepEqual(await findRecentUpload(fakeD1([savedRow("photo-a")]), match, 0), { id: "photo-a", moderationStatus: "pending" });
});

test("an upload with no recent matching row is not deduplicated", { skip: needsTypeStripping }, async () => {
  assert.equal(await findRecentUpload(fakeD1([]), match, 0), null);
  // Rows outside the retry window or already rejected do not count as saved.
  assert.equal(await findRecentUpload(fakeD1([savedRow("old", UPLOAD_RETRY_WINDOW_MS * 2)]), match, 0), null);
  assert.equal(await findRecentUpload(fakeD1([{ ...savedRow("bad"), moderation_status: "rejected" }]), match, 0), null);
});

test("dedupe position matches each retried file to a distinct prior row", { skip: needsTypeStripping }, async () => {
  const db = fakeD1([savedRow("first", 120_000), savedRow("second", 30_000)]);
  // Two committed rows cover two retried same-name+size files, in upload order.
  assert.equal((await findRecentUpload(db, match, 0)).id, "first");
  assert.equal((await findRecentUpload(db, match, 1)).id, "second");
  // A third occurrence has no committed row, so it is inserted as new.
  assert.equal(await findRecentUpload(db, match, 2), null);
  // When the client reports one known save, the next file starts at position 1.
  assert.equal((await findRecentUpload(db, match, 1)).id, "second");
});

test("parseKnownSaved reads the counts the upload form posts back", { skip: needsTypeStripping }, () => {
  assert.deepEqual(parseKnownSaved('{"good.png:12":1,"clip.mov:9":2}'), new Map([["good.png:12", 1], ["clip.mov:9", 2]]));
  assert.deepEqual(parseKnownSaved(null), new Map());
  assert.deepEqual(parseKnownSaved("not json"), new Map());
  assert.deepEqual(parseKnownSaved('{"a:1":"nope","b:2":0}'), new Map());
});
