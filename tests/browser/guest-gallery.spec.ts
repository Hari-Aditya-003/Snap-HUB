import { expect, test } from "@playwright/test";
import { type LocalWorker, startLocalWorker } from "./local-worker";

// A tiny valid 1x1 PNG: it passes the guest-upload signature check and the
// fake Drive adapter serves it back to <img> elements.
const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64",
);

const ALBUM_ID = "browser-smoke-event";
const GUEST_TOKEN = "browser-smoke-token";

// A live link-access event with manual moderation, guest uploads enabled, and
// three approved host items covering PNG, JPEG, and MP4 media types. The
// drive_* columns are pre-populated so the album behaves like an event that
// was already connected to Drive; with SNAP_HUB_FAKE_DRIVE=1 set by the
// helper, no Google traffic ever happens.
const SEED_SQL = `
INSERT INTO albums (id, title, event_type, event_date, description, tagline, location, theme,
  expected_guests, status, access_mode, allow_guest_uploads, moderation_mode, downloads_enabled,
  access_token, guest_username, guest_password_hash,
  drive_folder_id, drive_photos_folder_id, drive_videos_folder_id, drive_guest_uploads_folder_id, created_at)
VALUES ('${ALBUM_ID}', 'Browser smoke event', 'Celebration', '',
  'A fixture event for the browser smoke suite.', 'Every memory in one place', '',
  'rose', 0, 'live', 'link', 1, 'manual', 1,
  '${GUEST_TOKEN}', 'unused-guest', 'unused-hash',
  'fake-event-folder', 'fake-photos-folder', 'fake-videos-folder', 'fake-guest-uploads-folder', 1700000000000);
INSERT INTO photos (id, album_id, object_key, filename, content_type, caption, is_featured,
  collection_id, moderation_status, uploader_name, source, size, created_at) VALUES
  ('browser-photo-1', '${ALBUM_ID}', 'fake-drive-browser-photo-1', 'first-dance.png', 'image/png',
   'First dance', 0, NULL, 'approved', 'Host', 'host', ${PNG_BYTES.byteLength}, 1700000002000),
  ('browser-photo-2', '${ALBUM_ID}', 'fake-drive-browser-photo-2', 'cake-cutting.jpg', 'image/jpeg',
   'Cake cutting', 1, NULL, 'approved', 'Host', 'host', 223, 1700000001000),
  ('browser-photo-3', '${ALBUM_ID}', 'fake-drive-browser-photo-3', 'highlight-clip.mp4', 'video/mp4',
   'Highlight clip', 0, NULL, 'approved', 'Host', 'host', 1979, 1700000000000);
`;

let worker: LocalWorker;

test.beforeAll(async () => {
  // Cold machines can take a while to boot workerd and apply the D1 fixture.
  test.setTimeout(300_000);
  worker = await startLocalWorker({ seedSql: SEED_SQL });
});

test.afterAll(async () => {
  await worker?.stop();
});

function galleryUrl() {
  return `${worker.origin}/g/${GUEST_TOKEN}`;
}

test("guest opens the event link, browses media, and opens and closes the viewer", async ({ page }) => {
  await page.goto(galleryUrl());

  await expect(page.getByRole("heading", { name: "Browser smoke event" })).toBeVisible();
  await expect(page.getByText("3 memories")).toBeVisible();
  const cards = page.locator(".memory-card");
  await expect(cards).toHaveCount(3);
  // Thumbnails stream through the fake Drive adapter — never Google — and the
  // bytes actually decode in the browser.
  for (const image of [cards.nth(0).locator("img"), cards.nth(1).locator("img")]) {
    await expect(image).toBeVisible();
    await expect
      .poll(async () => image.evaluate((element) => element instanceof HTMLImageElement
        && element.complete && element.naturalWidth > 0))
      .toBe(true);
  }

  await cards.first().getByRole("button", { name: "Open first-dance.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Memory viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".slide-info")).toContainText("First dance");
  await expect(viewer.locator(".slide-info")).toContainText("1 of 3");
  await expect
    .poll(async () => viewer.locator(".slide-stage img")
      .evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0))
    .toBe(true);

  await viewer.getByRole("button", { name: "Next memory" }).click();
  await expect(viewer.locator(".slide-info")).toContainText("Cake cutting");
  await expect(viewer.locator(".slide-info")).toContainText("2 of 3");

  // The fake adapter serves a genuinely playable MP4 for video entries and
  // honours byte-range requests the way Drive does.
  await viewer.getByRole("button", { name: "Next memory" }).click();
  await expect(viewer.locator(".slide-info")).toContainText("Highlight clip");
  await expect(viewer.locator(".slide-info")).toContainText("3 of 3");
  const clip = viewer.locator(".slide-stage video");
  await expect(clip).toBeVisible();
  await expect
    .poll(async () => clip.evaluate((element) => element instanceof HTMLVideoElement && element.readyState >= 1))
    .toBe(true);

  const ranged = await page.request.get(`${worker.origin}/api/gallery/${GUEST_TOKEN}/photos/browser-photo-3`, {
    headers: { Range: "bytes=0-99" },
  });
  expect(ranged.status()).toBe(206);
  expect(ranged.headers()["content-range"]).toBe("bytes 0-99/1979");

  await viewer.getByRole("button", { name: "Close viewer" }).click();
  await expect(viewer).toBeHidden();
});

test("pending guest upload appears in the gallery only after host approval", async ({ page }) => {
  await page.goto(galleryUrl());
  const cards = page.locator(".memory-card");
  const pendingCard = page.locator(".memory-card", { hasText: "Disposable upload" });
  await expect(cards).toHaveCount(3);

  await page.getByRole("button", { name: "Add memories" }).click();
  const panel = page.locator(".guest-upload-panel");
  await expect(panel).toBeVisible();
  await panel.locator('input[name="uploaderName"]').fill("Smoke Guest");
  await panel.locator('input[name="caption"]').fill("Disposable upload");
  await panel.locator('input[name="photos"]').setInputFiles({
    name: "guest-upload.png", mimeType: "image/png", buffer: PNG_BYTES,
  });

  const uploadResponse = page.waitForResponse(
    (response) => response.url().includes(`/api/gallery/${GUEST_TOKEN}/upload`)
      && response.request().method() === "POST",
  );
  await panel.getByRole("button", { name: "Send for approval" }).click();
  const uploaded = await (await uploadResponse).json() as {
    photos: Array<{ id: string; filename: string; moderationStatus: string }>;
    moderationStatus: string;
  };
  expect(uploaded.moderationStatus).toBe("pending");
  expect(uploaded.photos).toHaveLength(1);
  await expect(page.getByText("Uploaded — the host will approve these memories")).toBeVisible();
  // Manual moderation keeps the pending upload hidden — including on a fresh
  // server render, not just in the client-side list state.
  await page.reload();
  await expect(cards).toHaveCount(3);
  await expect(pendingCard).toHaveCount(0);

  // The host approves through the same PATCH endpoint the dashboard calls.
  const login = await page.request.post(`${worker.origin}/api/admin/login`, {
    form: { username: worker.adminUsername, password: worker.adminPassword },
    maxRedirects: 0,
  });
  expect(login.status()).toBe(303);
  const approve = await page.request.patch(`${worker.origin}/api/photos/${uploaded.photos[0].id}`, {
    data: { moderationStatus: "approved" },
  });
  expect(approve.ok()).toBeTruthy();

  await page.reload();
  await expect(cards).toHaveCount(4);
  await expect(pendingCard).toBeVisible();
  await pendingCard.getByRole("button", { name: "Open guest-upload.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Memory viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".slide-info")).toContainText("Disposable upload");
});
