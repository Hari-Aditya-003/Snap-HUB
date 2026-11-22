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
const { checkMediaFile, splitMediaFiles, MAX_MEDIA_FILE_SIZE } = uploads ?? {};

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
  // The guest view keys confirmed uploads as `${filename}:${size}` from the API response.
  const saved = new Set(accepted.map((file) => `${file.name}:${file.size}`));
  const retry = batch.filter((file) => !saved.has(`${file.name}:${file.size}`));
  assert.deepEqual(retry.map((file) => file.name), ["huge.mov", "notes.txt"]);
  const secondAttempt = await splitMediaFiles(retry);
  assert.equal(secondAttempt.accepted.length, 0);
  assert.deepEqual(secondAttempt.rejected, rejected);
});
