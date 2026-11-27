import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
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

  const opener = cards.first().getByRole("button", { name: "Open first-dance.png" });
  await opener.focus();
  await page.keyboard.press("Enter");
  const viewer = page.getByRole("dialog", { name: "Memory viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.getByRole("button", { name: "Close viewer" })).toBeFocused();
  await page.keyboard.press("Shift+Tab");
  await expect(viewer.getByRole("button", { name: "Next memory" })).toBeFocused();
  await expect(viewer.locator(".slide-info")).toContainText("First dance");
  await expect(viewer.locator(".slide-info")).toContainText("1 of 3");
  await expect
    .poll(async () => viewer.locator(".slide-stage img")
      .evaluate((element) => element instanceof HTMLImageElement && element.complete && element.naturalWidth > 0))
    .toBe(true);

  await page.keyboard.press("ArrowRight");
  await expect(viewer.locator(".slide-info")).toContainText("Cake cutting");
  await expect(viewer.locator(".slide-info")).toContainText("2 of 3");
  await expect(viewer.getByRole("status")).toContainText(/Memory 2 of 3.*Cake cutting/);

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

  await page.keyboard.press("Escape");
  await expect(viewer).toBeHidden();
  await expect(opener).toBeFocused();

  await page.getByRole("button", { name: "Videos", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await cards.first().getByRole("button", { name: "Open highlight-clip.mp4" }).click();
  await expect(viewer.getByRole("status")).toContainText("Memory 1 of 1");
  await expect(viewer.getByRole("button", { name: "Next memory" })).toBeDisabled();
  await page.keyboard.press("Escape");
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

  await signIn(page);
  await page.goto(`${worker.origin}/admin`);
  const pending = page.locator(".host-media-card").filter({ has: page.getByRole("img", { name: "Disposable upload" }) });
  const approved = page.waitForResponse((response) => response.url().endsWith(`/api/photos/${uploaded.photos[0].id}`)
    && response.request().method() === "PATCH");
  await pending.getByRole("button", { name: "Approve" }).click();
  expect((await approved).ok()).toBe(true);
  await expect(pending.locator(".moderation-badge")).toHaveText("approved");

  await page.goto(galleryUrl());
  await expect(cards).toHaveCount(4);
  await expect(pendingCard).toBeVisible();
  await pendingCard.getByRole("button", { name: "Open guest-upload.png" }).click();
  const viewer = page.getByRole("dialog", { name: "Memory viewer" });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator(".slide-info")).toContainText("Disposable upload");
});

async function signIn(page: Page) {
  const response = await page.request.post(`${worker.origin}/api/admin/login`, {
    form: { username: worker.adminUsername, password: worker.adminPassword },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(303);
}

test("a mixed upload survives a dropped response and acknowledges the same saved photo", async ({ page }) => {
  await page.goto(galleryUrl());
  await page.getByRole("button", { name: "Add memories" }).click();
  const panel = page.locator(".guest-upload-panel");
  const send = panel.getByRole("button", { name: "Send for approval" });
  await panel.getByRole("textbox", { name: "Caption" }).fill("Recover this caption");
  await panel.locator('input[name="photos"]').setInputFiles([
    { name: "retry.png", mimeType: "image/png", buffer: PNG_BYTES },
    { name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("notes") },
  ]);
  const savedIds: string[] = [];
  await page.route(`**/api/gallery/${GUEST_TOKEN}/upload`, async (route) => {
    const response = await route.fetch();
    const result = await response.json() as { photos: Array<{ id: string }> };
    savedIds.push(result.photos[0]?.id ?? "");
    if (savedIds.length === 1) await route.abort();
    else await route.fulfill({ response });
  });
  await send.click();
  await expect(page.getByText(/check your connection and try again/i)).toBeVisible();
  await expect(send).toBeEnabled();
  await expect(panel.getByRole("textbox", { name: "Caption" })).toHaveValue("Recover this caption");
  await send.click();
  await expect(panel.locator(".upload-summary")).toContainText("notes.txt");
  await expect(panel.locator(".upload-summary")).toContainText("retry.png");
  expect(savedIds).toHaveLength(2);
  expect(savedIds[0]).toMatch(/^upload-/);
  expect(savedIds[1]).toBe(savedIds[0]);

  await signIn(page);
  const dashboard = await page.request.get(`${worker.origin}/api/albums`);
  const { photos } = await dashboard.json() as { photos: Array<{ filename: string; caption: string }> };
  const saved = photos.filter(({ filename }) => filename === "retry.png");
  expect(saved).toHaveLength(1);
  expect(saved[0].caption).toBe("Recover this caption");
});

test("host downloads a printable PNG sign for the selected QR target", async ({ page }) => {
  await signIn(page);
  await page.goto(`${worker.origin}/admin`);
  const share = page.locator(".qr-card");
  await share.getByRole("button", { name: "Upload", exact: true }).click();
  await expect(share.getByRole("link", { name: "Open upload" })).toHaveAttribute("href", /\?upload=1$/);
  const downloaded = page.waitForEvent("download");
  await share.getByRole("button", { name: "Download print sign" }).click();
  const file = await downloaded;
  expect(file.suggestedFilename()).toBe("browser-smoke-event-upload-sign.png");
  const bytes = await readFile(await file.path());
  expect(bytes.subarray(1, 4).toString()).toBe("PNG");
  expect(bytes.readUInt32BE(16)).toBe(1600);
  expect(bytes.readUInt32BE(20)).toBe(2000);
});

test("slideshow recovers from a delayed poll and follows host next and previous", async ({ page }) => {
  await signIn(page);
  const control = `${worker.origin}/api/albums/${ALBUM_ID}/slideshow`;
  expect((await page.request.patch(control, { data: { action: "restart" } })).ok()).toBe(true);
  let pending = 0;
  let peak = 0;
  let first = true;
  await page.route(`**/api/gallery/${GUEST_TOKEN}/media`, async (route) => {
    pending += 1;
    peak = Math.max(peak, pending);
    try {
      if (first) {
        first = false;
        // A visibility change and the regular poll occur while this call is in flight.
        await new Promise((resolve) => setTimeout(resolve, 1900));
        await route.fulfill({ status: 503, body: "Temporarily unavailable" });
      } else {
        await route.continue();
      }
    } finally {
      pending -= 1;
    }
  });
  await page.goto(`${galleryUrl()}/slideshow`);
  const pause = page.getByRole("button", { name: "Pause on this screen" });
  await pause.click();
  await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  await expect(page.getByText("Reconnecting…")).toBeVisible();
  await expect(page.getByText("Live control connected")).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume on this screen" })).toBeEnabled();
  expect(peak).toBe(1);

  const slide = page.locator(".live-show-media");
  await expect(slide).toContainText("1 /");
  expect((await page.request.patch(control, { data: { action: "next" } })).ok()).toBe(true);
  await expect(slide).toContainText("2 /");
  expect((await page.request.patch(control, { data: { action: "previous" } })).ok()).toBe(true);
  await expect(slide).toContainText("1 /");
});

test("Drive status failure leaves events usable and can be retried", async ({ page }) => {
  await signIn(page);
  let first = true;
  await page.route("**/api/admin/google-drive/status", async (route) => {
    if (first) {
      first = false;
      await route.fulfill({ status: 503 });
    } else {
      await route.continue();
    }
  });
  await page.goto(`${worker.origin}/admin`);
  await expect(page.getByRole("heading", { name: "Browser smoke event" })).toBeVisible();
  await expect(page.getByText("Could not check Google Drive. You can still manage your events.")).toBeVisible();
  await page.getByRole("button", { name: "Check connection" }).click();
  await expect(page.getByRole("link", { name: "Google OAuth setup guide" })).toBeVisible();
});

test("clipboard failure offers the exact current sharing target for manual copy", async ({ page }) => {
  await signIn(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("Denied")) } });
  });
  await page.goto(`${worker.origin}/admin`);
  const share = page.locator(".qr-card");
  for (const [tab, target] of [["Gallery", ""], ["Upload", "?upload=1"], ["Slideshow", "/slideshow"]]) {
    await share.getByRole("button", { name: tab, exact: true }).click();
    await share.getByRole("button", { name: new RegExp(tab + " link", "i") }).click();
    await expect(share.getByRole("textbox", { name: /select and copy manually/i })).toHaveValue(galleryUrl() + target);
  }
});
