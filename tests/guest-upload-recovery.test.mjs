import assert from "node:assert/strict";
import { test } from "node:test";

import {
  checkMediaFile, MAX_MEDIA_FILE_SIZE, describeNames, describeRejected,
  prepareUploads, readUploadKeys, saveMediaFiles, splitMediaFiles,
} from "../lib/uploads.ts";

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

test("an acknowledged file is left out of the next request", () => {
  const files = [png("same.png"), png("same.png")];
  const first = prepareUploads(new FormData(), files, null);
  first.selection.saved.add(first.selection.keys[0]);
  const body = new FormData();
  const second = prepareUploads(body, files, first.selection);
  assert.equal(second.count, 1);
  assert.equal(second.alreadySaved, 1);
  assert.deepEqual(body.getAll("uploadKeys"), [first.selection.keys[1]]);
  assert.deepEqual(body.getAll("photos"), [files[1]]);
});

test("different selections of a same-named file always get independent identities", () => {
  const first = prepareUploads(new FormData(), [png()], null);
  const second = prepareUploads(new FormData(), [png()], first.selection);
  assert.notEqual(first.selection.keys[0], second.selection.keys[0]);
});

test("invalid, missing, and repeated identities are handled before upload", () => {
  const files = [png(), png()];
  const body = new FormData();
  assert.equal(readUploadKeys(body, files).size, 0);
  const key = crypto.randomUUID();
  body.append("uploadKeys", key);
  assert.equal(readUploadKeys(body, files), null);
  body.append("uploadKeys", key);
  assert.equal(readUploadKeys(body, files), null);
});

const scope = { albumId: "event-a", source: "guest" };
function fixture() {
  const rows = new Map();
  return {
    rows,
    db: { prepare: () => ({ bind: (id) => ({ first: async () => rows.get(id) ?? null }) }) },
    save: async (file, id) => {
      rows.set(id, { filename: file.name, size: file.size, moderation_status: "pending" });
      return "pending";
    },
  };
}

test("a lost response returns the existing photo, and a fresh selection saves independently", async () => {
  const { db, rows, save } = fixture();
  const files = [png()];
  const keys = new Map([[files[0], crypto.randomUUID()]]);
  const first = await saveMediaFiles(db, files, scope, keys, save);
  const retry = await saveMediaFiles(db, files, scope, keys, async () => assert.fail("retry wrote to Drive"));
  assert.deepEqual(retry.photos, first.photos);
  assert.equal(retry.inserted, 0);
  const second = await saveMediaFiles(db, files, scope, new Map([[files[0], crypto.randomUUID()]]), save);
  assert.notEqual(second.photos[0].id, first.photos[0].id);
  assert.equal(rows.size, 2);
});

test("a concurrent retry reports the winning insert", async () => {
  const { db, save } = fixture();
  const file = png();
  const keys = new Map([[file, crypto.randomUUID()]]);
  const result = await saveMediaFiles(db, [file], scope, keys, async (item, id) => {
    await save(item, id);
    throw new Error("primary key conflict");
  });
  assert.equal(result.inserted, 0);
  assert.equal(result.photos[0].moderationStatus, "pending");
});

test("a mid-batch failure keeps the confirmed files in the response", async () => {
  const { db, save } = fixture();
  const outcome = { photos: [], inserted: 0 };
  await assert.rejects(
    saveMediaFiles(db, [png("first.png"), png("second.png")], scope, new Map(), async (file, id) => {
      if (file.name === "second.png") throw new Error("Drive unavailable");
      return save(file, id);
    }, outcome),
    /Drive unavailable/,
  );
  assert.equal(outcome.inserted, 1);
  assert.equal(outcome.photos[0].filename, "first.png");
});

test("accepted and rejected filenames are both describable for mixed results", () => {
  assert.equal(describeNames(["a.png", "b.png", "c.png", "d.png"]), "a.png, b.png, c.png +1 more");
  assert.equal(describeRejected([
    { filename: "huge.mov", reason: "over 75 MB" },
    { filename: "notes.txt", reason: "unsupported file type" },
  ]), "huge.mov (over 75 MB), notes.txt (unsupported file type)");
});
