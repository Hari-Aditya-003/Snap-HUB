import assert from "node:assert/strict";
import { test } from "node:test";

// The upload routes' per-file outcome logic lives in lib/uploads.ts and is
// exercised here with real File objects plus a small D1 stand-in — no Worker,
// Drive or migration needed. A failed import must fail loudly, not skip.
let uploads;
try {
  uploads = await import("../lib/uploads.ts");
} catch (error) {
  if (error?.code === "ERR_UNKNOWN_FILE_EXTENSION") {
    throw new Error("These tests require Node >= 22.18 (or node --experimental-strip-types) to import ../lib/uploads.ts", { cause: error });
  }
  throw error;
}
const {
  checkMediaFile, splitMediaFiles, MAX_MEDIA_FILE_SIZE, filterUnsentFiles, findRecentUpload,
  saveMediaFiles, countSavedUploads, describeNames, describeRejected,
  mediaUploadKey, parseKnownSaved, UPLOAD_RETRY_WINDOW_MS,
} = uploads;

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

test("a valid photo is accepted", async () => {
  assert.deepEqual(await checkMediaFile(png()), { ok: true });
  assert.deepEqual(await checkMediaFile(new File([new Uint8Array([...JPEG_HEADER, 0, 0])], "pic.jpg", { type: "image/jpeg" })), { ok: true });
});

test("an oversized file is rejected with a size reason", async () => {
  assert.deepEqual(await checkMediaFile(oversized()), { ok: false, reason: "over 75 MB" });
});

test("an unsupported type is rejected before its signature is read", async () => {
  assert.deepEqual(await checkMediaFile(new File(["hello"], "notes.txt", { type: "text/plain" })), { ok: false, reason: "unsupported file type" });
  // Even with a media MIME type, a disallowed extension is still rejected.
  assert.deepEqual(await checkMediaFile(new File([new Uint8Array(PNG_HEADER)], "fake.png.exe", { type: "image/png" })), { ok: false, reason: "unsupported file type" });
});

test("a spoofed media file is rejected by its signature", async () => {
  assert.deepEqual(await checkMediaFile(new File(["not a real jpeg"], "photo.jpg", { type: "image/jpeg" })), { ok: false, reason: "unrecognized file contents" });
});

test("a mixed batch is split into accepted files and per-file rejections", async () => {
  const batch = [png("good.png"), oversized("huge.mov"), new File(["plain text"], "notes.txt", { type: "text/plain" })];
  const { accepted, rejected } = await splitMediaFiles(batch);
  assert.deepEqual(accepted.map((file) => file.name), ["good.png"]);
  assert.deepEqual(rejected, [
    { filename: "huge.mov", reason: "over 75 MB" },
    { filename: "notes.txt", reason: "unsupported file type" },
  ]);
});

test("a fully rejected batch explains every failure", async () => {
  const { accepted, rejected } = await splitMediaFiles([
    oversized("huge.mov"),
    new File(["plain text"], "notes.txt", { type: "text/plain" }),
  ]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected.length, 2);
});

test("a retry that filters out confirmed saves only resends the rejected files", async () => {
  const batch = [png("good.png"), oversized("huge.mov"), new File(["plain text"], "notes.txt", { type: "text/plain" })];
  const { accepted, rejected } = await splitMediaFiles(batch);
  // The views count confirmed uploads per `filename:size` key from the API response.
  const saved = countSavedUploads(new Map(), accepted.map((file) => ({ filename: file.name, size: file.size })));
  const retry = filterUnsentFiles(batch, saved);
  assert.deepEqual(retry.map((file) => file.name), ["huge.mov", "notes.txt"]);
  const secondAttempt = await splitMediaFiles(retry);
  assert.equal(secondAttempt.accepted.length, 0);
  assert.deepEqual(secondAttempt.rejected, rejected);
});

test("two distinct files with the same name and size are not both skipped on retry", () => {
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
  const calls = [];
  const db = {
    calls,
    prepare: () => ({
      bind: (albumId, filename, size, uploaderName, source, cutoff, offset = 0) => {
        calls.push([albumId, filename, size, uploaderName, source, cutoff, offset]);
        return {
          first: async () => rows
            .filter((row) => row.album_id === albumId && row.filename === filename && row.size === size
              && row.uploader_name === uploaderName && row.source === source
              && row.moderation_status !== "rejected" && row.created_at > cutoff)
            .sort((a, b) => a.created_at - b.created_at)[offset] ?? null,
        };
      },
    }),
  };
  return db;
}

const match = { albumId: "album-1", uploaderName: "Guest", source: "guest" };

function savedRow(id, { filename = "good.png", size = 12, ageMs = 60_000, moderation_status = "pending" } = {}) {
  return { id, moderation_status, album_id: "album-1", filename, size, uploader_name: "Guest", source: "guest", created_at: Date.now() - ageMs };
}

test("a just-saved upload is deduplicated instead of inserted again", async () => {
  const db = fakeD1([savedRow("photo-a")]);
  assert.deepEqual(await findRecentUpload(db, { ...match, filename: "good.png", size: 12 }, 0), { id: "photo-a", moderationStatus: "pending" });
  // The request asks for the row matching the file's identity at position 0.
  assert.equal(db.calls[0][0], "album-1");
  assert.equal(db.calls[0][1], "good.png");
  assert.equal(db.calls[0][6], 0);
});

test("an upload with no recent matching row is not deduplicated", async () => {
  assert.equal(await findRecentUpload(fakeD1([]), { ...match, filename: "good.png", size: 12 }, 0), null);
  // Rows outside the retry window or already rejected do not count as saved.
  assert.equal(await findRecentUpload(fakeD1([savedRow("old", { ageMs: UPLOAD_RETRY_WINDOW_MS * 2 })]), { ...match, filename: "good.png", size: 12 }, 0), null);
  assert.equal(await findRecentUpload(fakeD1([savedRow("bad", { moderation_status: "rejected" })]), { ...match, filename: "good.png", size: 12 }, 0), null);
});

test("dedupe position matches each retried file to a distinct prior row", async () => {
  const db = fakeD1([savedRow("first", { ageMs: 120_000 }), savedRow("second", { ageMs: 30_000 })]);
  const fileMatch = { ...match, filename: "good.png", size: 12 };
  // Two committed rows cover two retried same-name+size files, in upload order.
  assert.equal((await findRecentUpload(db, fileMatch, 0)).id, "first");
  assert.equal((await findRecentUpload(db, fileMatch, 1)).id, "second");
  // A third occurrence has no committed row, so it is inserted as new.
  assert.equal(await findRecentUpload(db, fileMatch, 2), null);
});

test("parseKnownSaved reads the counts the upload form posts back", () => {
  assert.deepEqual(parseKnownSaved('{"good.png:12":1,"clip.mov:9":2}'), new Map([["good.png:12", 1], ["clip.mov:9", 2]]));
  assert.deepEqual(parseKnownSaved(null), new Map());
  assert.deepEqual(parseKnownSaved("not json"), new Map());
  assert.deepEqual(parseKnownSaved('{"a:1":"nope","b:2":0}'), new Map());
});

// The route-level save flow: classification, per-position dedupe, and partial
// results surviving a mid-batch failure all run through saveMediaFiles.
test("a successful retry after a lost response reports existing rows and inserts nothing", async () => {
  const db = fakeD1([savedRow("committed-a"), savedRow("committed-b", { ageMs: 30_000 })]);
  const batch = [png("good.png"), png("good.png")];
  const { accepted } = await splitMediaFiles(batch);
  let saves = 0;
  const outcome = { photos: [], inserted: 0 };
  await saveMediaFiles(db, accepted, match, new Map(), async () => { saves += 1; return { id: "new", moderationStatus: "pending" }; }, outcome);
  assert.equal(saves, 0);
  assert.equal(outcome.inserted, 0);
  assert.deepEqual(outcome.photos.map((photo) => photo.id), ["committed-a", "committed-b"]);
});

test("a mixed batch dedupes committed files, inserts new ones, and reports rejects", async () => {
  const db = fakeD1([savedRow("already-saved")]);
  const newPhoto = new File([new Uint8Array([...JPEG_HEADER, 0, 0])], "fresh.jpg", { type: "image/jpeg" });
  const batch = [png("good.png"), newPhoto, new File(["plain text"], "notes.txt", { type: "text/plain" })];
  const { accepted, rejected } = await splitMediaFiles(batch);
  const outcome = { photos: [], inserted: 0 };
  await saveMediaFiles(db, accepted, match, new Map(), async (file) => ({ id: `new-${file.name}`, moderationStatus: "pending" }), outcome);
  assert.deepEqual(outcome.photos, [
    { id: "already-saved", filename: "good.png", size: 12, moderationStatus: "pending" },
    { id: "new-fresh.jpg", filename: "fresh.jpg", size: newPhoto.size, moderationStatus: "pending" },
  ]);
  assert.equal(outcome.inserted, 1);
  assert.deepEqual(rejected, [{ filename: "notes.txt", reason: "unsupported file type" }]);
});

test("files the client already confirmed start dedupe at their known position", async () => {
  const db = fakeD1([savedRow("only-one")]);
  // knownSaved={good.png:12:1} means the sent file is the second occurrence —
  // it must not collapse onto the single committed row.
  const outcome = { photos: [], inserted: 0 };
  const known = new Map([[mediaUploadKey("good.png", 12), 1]]);
  await saveMediaFiles(db, [png("good.png")], match, known, async (file) => ({ id: `new-${file.name}`, moderationStatus: "pending" }), outcome);
  assert.equal(outcome.inserted, 1);
  assert.equal(outcome.photos[0].id, "new-good.png");
});

test("a mid-batch failure keeps the committed files in the outcome", async () => {
  const db = fakeD1([]);
  const batch = [png("first.png"), png("second.png")];
  const outcome = { photos: [], inserted: 0 };
  await assert.rejects(
    saveMediaFiles(db, batch, match, new Map(), async (file) => {
      if (file.name === "second.png") throw new Error("drive exploded");
      return { id: `new-${file.name}`, moderationStatus: "pending" };
    }, outcome),
    /drive exploded/,
  );
  // The route responds with these partial saves and counts them as uploads.
  assert.equal(outcome.inserted, 1);
  assert.deepEqual(outcome.photos.map((photo) => photo.id), ["new-first.png"]);
});

test("accepted and rejected filenames are both describable for mixed results", () => {
  assert.equal(describeNames(["a.png", "b.png", "c.png", "d.png"]), "a.png, b.png, c.png +1 more");
  assert.equal(describeRejected([
    { filename: "huge.mov", reason: "over 75 MB" },
    { filename: "notes.txt", reason: "unsupported file type" },
  ]), "huge.mov (over 75 MB), notes.txt (unsupported file type)");
});
