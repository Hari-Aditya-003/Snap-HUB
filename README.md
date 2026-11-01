# Snap HUB

[![GitHub stars](https://img.shields.io/github/stars/Hari-Aditya-003/Snap-HUB?style=flat-square)](https://github.com/Hari-Aditya-003/Snap-HUB/stargazers)
[![GitHub forks](https://img.shields.io/github/forks/Hari-Aditya-003/Snap-HUB?style=flat-square)](https://github.com/Hari-Aditya-003/Snap-HUB/forks)
[![Default branch](https://img.shields.io/badge/branch-main-2563eb?style=flat-square)](https://github.com/Hari-Aditya-003/Snap-HUB/tree/main)

Snap HUB is a private event photo and video sharing platform. A host creates an event, uploads and moderates memories, then shares one QR code. Guests open the gallery in a browser, so they do not need to install an app.

The project is currently in testing stage. Purchases and paid plans are intentionally disabled.

## Standalone deployment

Snap HUB deploys to **Cloudflare Workers in your own Cloudflare account**, with D1 for metadata and Google Drive for original media. No ChatGPT account, Sites project, or ChatGPT-hosted domain is required.

Use the HTTPS URL returned by your Cloudflare deployment, or attach your own domain. See [deployment](docs/DEPLOYMENT.md) for account setup, secrets, OAuth, database migrations, and publishing.

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
cp .env.example .env
npm run db:migrate:local
npm run dev
```

Set strong local values for `ADMIN_USERNAME`, `ADMIN_PASSWORD`, and `SESSION_SECRET` in `.env`. Add a Google OAuth web client as `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`; its authorized redirect URI is `<site-origin>/api/admin/google-drive/callback`. The development server starts on <http://127.0.0.1:5173>.

Useful checks:

```bash
npm run lint
npm test
npm run deploy:check
```

Database migrations live in `drizzle/`. Local migrations use a local database; `npm run db:migrate:remote` explicitly applies them to your configured Cloudflare account. `npm test` builds the real Worker and checks its login, authorization, database access, and standalone artifact in an isolated local runtime.

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

## Documentation and contributions

- [Deployment and operation](docs/DEPLOYMENT.md)
- [Contributing](CONTRIBUTING.md): setup, checks, issue reports, and pull requests
- [Branches](https://github.com/Hari-Aditya-003/Snap-HUB/branches): `main` is the default branch; use a focused branch for each change.

If this project helps you, consider starring it. Fork it to propose improvements, then open a pull request against `main`. The stars and forks badges above update from GitHub; they are not fixed counts.
