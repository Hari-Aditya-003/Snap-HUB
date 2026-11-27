# Snap HUB

[![GitHub stars](https://img.shields.io/github/stars/Hari-Aditya-003/Snap-HUB?style=flat-square)](https://github.com/Hari-Aditya-003/Snap-HUB/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/Hari-Aditya-003/Snap-HUB?style=flat-square)](https://github.com/Hari-Aditya-003/Snap-HUB/forks)
[![Default branch](https://img.shields.io/badge/branch-main-2563eb?style=flat-square)](https://github.com/Hari-Aditya-003/Snap-HUB/tree/main)
[![MIT license](https://img.shields.io/github/license/Hari-Aditya-003/Snap-HUB?style=flat-square)](LICENSE)

Snap HUB is a private event photo and video sharing platform. A host creates an event, uploads and moderates memories, then shares one QR code. Guests open the gallery in a browser, so they do not need to install an app.

The project is currently in testing stage. Purchases and paid plans are intentionally disabled.

## Contribute

Help improve the guest gallery, host dashboard, self-hosted setup, or SwiftUI app. Start with a [good first issue](https://github.com/Hari-Aditya-003/Snap-HUB/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22) or look through the [roadmap and open issues](https://github.com/Hari-Aditya-003/Snap-HUB/issues). If you want to work on an issue, leave a comment with your approach so others can coordinate with you.

Use [GitHub Discussions](https://github.com/Hari-Aditya-003/Snap-HUB/discussions) for setup questions and early ideas. See the [contribution guide](CONTRIBUTING.md) for setup and verification, and the [security policy](SECURITY.md) for private reports.

## Standalone deployment

Snap HUB deploys to **Cloudflare Workers in your own Cloudflare account**, with D1 for metadata and Google Drive for original media. No ChatGPT account, Sites project, or ChatGPT-hosted domain is required.

Live website: [snap-hub.snap-hub.workers.dev](https://snap-hub.snap-hub.workers.dev). Host workspace: [admin](https://snap-hub.snap-hub.workers.dev/admin). You can also attach your own domain. See [deployment](docs/DEPLOYMENT.md) for account setup, secrets, OAuth, database migrations, and publishing.

- Worker configuration: `wrangler.json`
- iOS app: `ios/SnapHUB/SnapHUB.xcodeproj`
- iOS server setting: `SNAPHUB_SERVER_URL`
- Bundle identifier: `com.mradityahari.snaphub`

Host credentials are runtime secrets and are never committed to the repository.

## What is included

- Host authentication with signed, HTTP-only sessions and login rate limiting
- Event creation for weddings, birthdays, festivals, graduations, corporate events, concerts, and other celebrations
- Private guest links, generated or rotated guest IDs/passwords, and downloadable QR codes
- Separate QR targets for the gallery, guest uploads, and live slideshow
- Photo and video uploads directly to the host's Google Drive
- Collections, captions, event cover photos, themes, and welcome text
- Guest uploads with manual or instant moderation
- Favorites, highlights, search, photo/video filters, and original downloads
- Event status controls for draft, live, paused, and completed events
- Owner-only event deletion that removes database records and stored media objects
- Database-backed event activity for gallery views, guest uploads, and downloads
- Host-controlled live slideshow with previous, next, pause, resume, restart, and ambient music
- Responsive guest and host web experiences with installable PWA metadata
- Native SwiftUI iPhone/iPad host shell with a configurable server origin

## Supported photo and video uploads

Hosts and guests share the same validation rules: each file is checked by MIME type, extension, and file signature before it reaches Google Drive.

| Kind | Formats | Notes |
| --- | --- | --- |
| Photos | JPEG, PNG, WebP, GIF, HEIC, HEIF | `.jpg`, `.jpeg`, `.png`, `.webp`, `.gif`, `.heic`, `.heif` |
| Videos | MP4, MOV (QuickTime), WebM | `.mp4`, `.mov`, `.webm` |

- **Per-file limit:** 75 MB (75 MiB).
- **Per submission:** up to 20 files, and the whole batch may total up to 100 MB (100 MiB).
- iPhone formats such as HEIC and MOV are accepted for upload. Successful upload does not guarantee in-browser playback — most browsers cannot display HEIC images, and MOV files may use codecs the browser cannot decode. MP4/H.264 has the broadest playback support.
- A batch over the 20-file or 100 MB limits is rejected entirely. Within an accepted batch, files that fail type, signature, or size checks are skipped; the rest still upload.
- Guest uploads additionally require the event to be live with guest uploads enabled, and are rate-limited to 8 submissions per 10 minutes per guest IP per event — rejected requests also consume that quota.

## Architecture

- Next.js-compatible React application built with Vinext and Vite
- Cloudflare Workers deployed directly with Wrangler
- D1 for event and media metadata
- Google Drive for every original photo and video; the Site keeps no media-object storage
- SwiftUI and `WKWebView` for the signed iOS host app

The host connects Google Drive with OAuth from the admin dashboard. Snap HUB requests the limited `drive.file` scope and creates this structure automatically:

```text
Snap HUB/
  Event name/
    Photos/
    Videos/
    Guest Uploads/
    Highlights/
```

Only event records, guest-access controls, captions, moderation state, and Google file IDs remain in D1. The original media bytes are stored only in Google Drive.

## Local web development

Requirements: Node.js 22.13 or newer and npm.

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Set strong local values for `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in `.dev.vars`. The development server starts on <http://127.0.0.1:5173>. You can open the homepage, sign in at `/admin`, and run the automated checks with local D1 and no Cloudflare or Google account. Creating events and uploading media require connecting your own [Google Drive OAuth client](docs/DEPLOYMENT.md#google-drive-setup).

### Sample gallery without Google Drive

To review the guest gallery — filters, search, captions, favorites, collections, and the media viewer — without any credentials, seed a disposable sample event into local D1:

```bash
npm run sample:gallery   # applies local migrations + inserts the sample event
npm run dev              # then open http://127.0.0.1:5173/g/sample-gallery-token
                         # (friendly URL: /e/sample-gallery)
```

The event is live with link access, so no sign-in is needed. It contains 7 generated photos and 2 generated videos across 3 collections, with captions, highlights, a cover photo, and one uncategorized item. Guest uploads are intentionally disabled: the sample gallery is browse-only, so reseeding or resetting it can never mix in real uploads or leave orphaned files in Google Drive.

The command is strictly local: it requires `--local`, rejects remote arguments, and never needs OAuth secrets. If `.dev.vars` is missing it is created with throwaway local credentials. Seeded media rows use reserved `sample:` object keys; the dev server synthesizes their bytes on the fly (see `lib/sample-media.ts`) only when `SAMPLE_MEDIA=1` is set in `.dev.vars` **and** the request is localhost. The deployed Worker has neither, so production always streams originals from Google Drive.

Reset options:

```bash
npm run sample:gallery:reset   # removes only the sample event
rm -rf .wrangler/state         # wipes ALL local D1 data; re-run db:migrate:local after
```

To verify a normal build still takes the Drive path for originals: run `npm run build` and start the Worker without `SAMPLE_MEDIA` in `.dev.vars` (or set `SAMPLE_MEDIA=0`). Requests to `sample:` object keys then return 404 instead of synthesized bytes — the dev-only branch in `lib/sample-media.ts` is gated off — and media for real events continues to resolve through their stored Google Drive file IDs.

Useful checks:

```bash
npm run lint
npm run typecheck
npm test
npm run deploy:check
npm audit --omit=dev
```

Database migrations live in `drizzle/`. Local migrations use a local database; `npm run db:migrate:remote` explicitly applies them to your configured Cloudflare account. `npm test` builds the real Worker and checks its login, authorization, database access, and standalone artifact in an isolated local runtime.

Browser smoke coverage lives in `tests/browser/` and drives a real Chromium window through the guest gallery and moderation: a guest opens an event link, browses media in the viewer, then uploads a photo that stays pending until the host approves it through the same PATCH endpoint the dashboard uses. The suite boots `wrangler dev` itself against a disposable local D1 database and enables `SNAP_HUB_FAKE_DRIVE`, a built-in fake adapter that only activates for loopback request URLs, so it never touches a Google account or the public internet.

```bash
npx playwright install --with-deps chromium   # one-time browser download
npm run test:browser                          # builds the Worker, then runs the smoke spec
```

CI must install the browser before running the suite — the same `npx playwright install --with-deps chromium` command, which also fetches the system libraries Chromium needs on Linux.

For the active security smoke suite, start the local server in one terminal and run `npm run test:security` in another. It verifies authorization boundaries, security headers, CSRF defenses, durable login throttling, signed-session tamper resistance, OAuth state validation, and upload signature checks. GitHub Actions repeats the dependency audit, lint, and production build on every push and pull request, while Dependabot monitors npm updates weekly.

## iOS build and installation

Open `ios/SnapHUB/SnapHUB.xcodeproj` in Xcode. Set the target’s user-defined `SNAPHUB_SERVER_URL` build setting to your deployed HTTPS origin (no `/admin` suffix), then choose your signing team. The project targets iOS/iPadOS 17 or newer and uses automatic signing for the configured Apple development team.

1. Connect and trust the iPhone or iPad.
2. Enable Developer Mode on the device.
3. Select the physical device as the run destination.
4. Build and run the `SnapHUB` scheme.

The app loads the host workspace at the configured origin, keeps the authenticated web session in its default WebKit data store, and provides native Home, Events, Uploads, Live, and Settings navigation.

## Access model

- Only the host/admin session can create events, change settings, upload host media, edit captions, approve or reject guest uploads, set cover photos, or delete media.
- Guests receive access through an event QR/private link and, when enabled, an event-specific guest ID and password.
- Guests can view approved media, save local favorites, and download originals only when the host enables downloads.
- Paused, draft, and completed events do not expose their gallery to ordinary guests.

## Deployment

Run `npm run deploy` after configuring your own Cloudflare account, D1 database, and runtime secrets. The command builds the Worker, applies remote D1 migrations, and deploys `dist/server/wrangler.json`. Google Drive uploads require a Google OAuth web client and the callback URI for the deployed origin. Follow the [complete deployment guide](docs/DEPLOYMENT.md).

## Further reading

- [Deployment and operation](docs/DEPLOYMENT.md)
- [Community code of conduct](CODE_OF_CONDUCT.md)

## License

Project-owned software and documentation are available under the [MIT License](LICENSE). The [asset and third-party notices](NOTICE.md) identify material with separate terms, including the Snap HUB branding and bundled audio.
