# Snap HUB: standalone Cloudflare deployment

Snap HUB runs directly on Cloudflare Workers in the owner's Cloudflare account. D1 stores event metadata, Google Drive stores original media, and the iOS host app loads your deployed HTTPS origin. The application does not require a Sites project, a ChatGPT account, or a ChatGPT-hosted domain.

## Current standalone deployment

- Website: [https://snap-hub.snap-hub.workers.dev](https://snap-hub.snap-hub.workers.dev)
- Host workspace: [https://snap-hub.snap-hub.workers.dev/admin](https://snap-hub.snap-hub.workers.dev/admin)
- Google OAuth callback: `https://snap-hub.snap-hub.workers.dev/api/admin/google-drive/callback`

The Worker is published. Google Drive client credentials and host consent must be configured before uploads or legacy-media transfer are available.

## Local setup

Use Node.js 22.13 or newer and npm:

```bash
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Fill `.dev.vars` before using authentication or Google Drive. Development runs at `http://127.0.0.1:5173`. The local migration command uses `--local` and never modifies the remote database.

| Runtime secret | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Host login name |
| `ADMIN_PASSWORD` | Strong host password |
| `SESSION_SECRET` | Session signatures and Google token encryption |
| `GOOGLE_CLIENT_ID` | Google OAuth web-client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web-client secret |

Generate a session secret with `openssl rand -hex 32`. Keep real values in ignored local files or Cloudflare secrets. Do not commit them.

## Configure your Cloudflare account

Install dependencies, then sign in with Wrangler:

```bash
npx wrangler login
npx wrangler whoami
```

`wrangler.json` is the source configuration. Its account ID and D1 database ID identify the owner's deployment; they are resource identifiers, not credentials. Fork owners must change/remove `account_id` and configure a database in their own account before remote operations.

For a new account/database:

```bash
npm run db:create
```

This creates `snap-hub-db` and updates its `DB` binding in `wrangler.json`. Reuse an existing intended database instead of creating a duplicate. Commit the reviewed resource configuration. Migration SQL lives in `drizzle/`.

## Validate before publishing

```bash
npm run lint
npm test
npm run deploy:check
```

`npm test` builds the real Worker, initializes an isolated local D1 database, and verifies public page loading, host login, invalid-credential rejection, authenticated album reads, and rejection of untrusted identity headers. Its test database is local and temporary.

`npm run deploy:check` bundles the deployable Worker using Wrangler's `--dry-run`; it does not upload it. The GitHub workflow runs these checks for pull requests and pushes to `main`.

`npm start` runs the built Worker locally. It is a local preview, not a Node production server. Development and built previews can have different ports, so register the exact OAuth callback for each origin you use.

## Publish

For an existing Worker with runtime secrets already configured:

```bash
npm run deploy
```

For the first deployment, put the secret values in an ignored, permission-restricted JSON or `.env` file and pass it to Wrangler:

```bash
npm run deploy -- --secrets-file /absolute/private/path/worker-secrets.json
```

The deploy command builds `dist/server/`, applies remote migrations, and publishes using `dist/server/wrangler.json`. The generated config includes the client assets and real D1 binding. Use the `workers.dev` URL returned by Wrangler, or attach a custom domain in Cloudflare. Do not infer a live URL from a Worker name.

Keep schema changes backward-compatible with the previously deployed Worker. Use expand-and-contract migrations so a successful migration followed by failed publication does not break the active version.

For automatic deployments, connect the repository to the Worker through Cloudflare Workers Builds. Use `npm ci` to install, `npm test` to build/verify, and `npm run deploy` to publish from the intended production branch. Runtime secrets belong to the Worker; local `.dev.vars` files are not automatically uploaded. A GitHub push alone does not deploy unless you configure that integration.

## Google Drive setup

1. Enable the Google Drive API in your Google Cloud project.
2. Configure the OAuth consent screen and add the host account as a test user if the app is in testing.
3. Create an OAuth client of type **Web application**.
4. Register `<deployed-https-origin>/api/admin/google-drive/callback` as an authorized redirect URI.
5. Add `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` as secrets on the Cloudflare Worker, or include them in the private secrets file when deploying.
6. Sign in at `<deployed-https-origin>/admin` and connect Google Drive from the host dashboard.

For local development, register:

```text
http://127.0.0.1:5173/api/admin/google-drive/callback
```

Google's [web-server OAuth rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation) permit localhost IP addresses. `localhost` and `127.0.0.1` remain different origins; use the same one in the browser and registered callback.

The app requests `drive.file` and creates its own Drive folder tree. Host uploads and new-event creation require a connected Drive account. An independently deployed login page does not confirm Drive is configured.

Changing `SESSION_SECRET` invalidates sessions and prevents decrypting existing stored refresh tokens. Preserve it when migrating an existing Drive connection, or reconnect Drive after changing it.

## iOS host app

Open `ios/SnapHUB/SnapHUB.xcodeproj` in Xcode. In the SnapHUB target's Build Settings, add a user-defined `SNAPHUB_SERVER_URL` with your deployed HTTPS origin, without `/admin` or a query/fragment. Choose your signing team and build/run on a trusted device.

The value is expanded into `SnapHUBServerURL` in the app's Info.plist. There is no fallback to the previous managed host. If the setting is missing or invalid, the app displays configuration guidance instead of sending requests to an unrelated server.

A command-line unsigned build can pass the setting explicitly:

```bash
xcodebuild build \
  -project ios/SnapHUB/SnapHUB.xcodeproj \
  -scheme SnapHUB \
  -configuration Release \
  -destination 'generic/platform=iOS' \
  CODE_SIGNING_ALLOWED=NO \
  SNAPHUB_SERVER_URL=https://your-deployed-origin
```

Use a real deployed origin for installation. TestFlight/App Store distribution still requires your Apple signing account.

## Existing-data migration

The previous managed deployment is a separate database and storage system. Moving the source repository or deploying a Worker does not copy its events or original media.

Export the source database, copy original media into the Drive folders created by the new OAuth client, and map each old object key to its new Drive file ID before importing photo records. Older album rows may also need their new Drive folder IDs. Preserve guest tokens and password hashes if existing gallery access should continue working.

Do not import legacy storage keys unchanged: they are not Google Drive file IDs. Keep a verified source backup and retain the original deployment until the migrated media can be viewed and downloaded from the standalone origin.

## Acceptance and recovery

Verify host login, event creation, Drive connection, host/guest uploads, moderation, guest link/password access, downloads, slideshow controls, and event deletion using a disposable event. Confirm private routes reject unauthenticated clients.

Record the source SHA and Worker version, and back up D1 before updates. Roll back with Cloudflare's deployment history or `wrangler rollback` when the prior Worker remains compatible with the current schema. Rolling back code does not undo SQL migrations or restore deleted Drive media.
