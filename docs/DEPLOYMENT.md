# Snap HUB: development and deployment

Snap HUB uses Vinext/Vite and the Cloudflare Worker runtime provided by OpenAI Sites. It requires a D1 binding named `DB`, server-side session secrets, and Google Drive OAuth. A generic static host cannot run its authenticated API routes.

## Existing deployment

- Site: [snap-hub-events.mr-adityahari.chatgpt.site](https://snap-hub-events.mr-adityahari.chatgpt.site)
- Host workspace: [/admin](https://snap-hub-events.mr-adityahari.chatgpt.site/admin)
- Sites project: `appgprj_6abe86dcb4e88191a703166818a90d86`
- Repository configuration: [hosting.json](../.openai/hosting.json)

The connected Sites project was active when this guide was prepared. That is a deployment-status observation, not an end-to-end test of uploads or authentication. Reuse this project for owner maintenance. Fork contributors must use a separate development/deployment project and must not publish to the original project ID.

## 1. Prepare local development

Requires Node.js 22.13 or newer, npm, and Git.

```bash
git clone https://github.com/Hari-Aditya-003/Snap-HUB.git
cd Snap-HUB
npm ci
cp .env.example .env
```

Fill the local values before starting the server:

| Variable | Purpose |
| --- | --- |
| `ADMIN_USERNAME` | Host login name |
| `ADMIN_PASSWORD` | Strong host password |
| `SESSION_SECRET` | Random secret used for sessions and Google Drive token protection |
| `GOOGLE_CLIENT_ID` | Google OAuth web application client ID |
| `GOOGLE_CLIENT_SECRET` | Google OAuth web application client secret |

Generate a random session value locally with `openssl rand -hex 32`. Do not put real values in issue reports, pull requests, screenshots, or source files.

```bash
npm run dev
```

The documented development URL is [127.0.0.1:5173](http://127.0.0.1:5173). Set the corresponding exact Google redirect URI, including the origin:

```text
http://127.0.0.1:5173/api/admin/google-drive/callback
```

Google's [web-server OAuth redirect rules](https://developers.google.com/identity/protocols/oauth2/web-server#uri-validation) exempt localhost IP addresses from the raw-IP restriction. `localhost` and `127.0.0.1` are different origins. The production callback is:

```text
https://snap-hub-events.mr-adityahari.chatgpt.site/api/admin/google-drive/callback
```

Enable the Drive API and configure a web OAuth client and consent screen in your Google project. The application requests `drive.file`; use the admin dashboard to connect the host's account.

## 2. Database setup

[db/index.ts](../db/index.ts) requires the Cloudflare D1 `DB` binding. [vite.config.ts](../vite.config.ts) provides a local database named `site-creator-d1` with a placeholder ID; this is not a real production database ID.

The checked-in [local migration config](../wrangler.local.json) points directly to `drizzle/` and uses the same placeholder database ID as Vite. Initialize the local database before using database-backed routes:

```bash
npx wrangler d1 migrations apply DB --local --config wrangler.local.json --persist-to .wrangler/state
npm run dev
```

For a built local preview, run `npm run build` and then `npm start`. The generated Worker config is `dist/server/wrangler.json`. Its default migration directory is `migrations/`, which is absent in this checkout; use `wrangler.local.json` for local migration commands.

Use the URL printed by Wrangler for the built preview and register that origin's OAuth callback separately if exercising Google login there. This preview may use a different port from `npm run dev`. Use the local migration config above if Wrangler cannot discover the migrations. Never add `--remote` to this local setup command.

For a schema change, edit `db/schema.ts`, run `npm run db:generate`, review the generated SQL, and commit the migration and Drizzle metadata. A schema file alone does not update an existing database. Use backward-compatible expand-and-contract migrations: add compatible structures first, deploy code using them, and remove obsolete structures in a later release. If migration succeeds but Worker publication fails, the previously active Worker must still function.

## 3. Validate a release

```bash
npm run lint
npm run build
```

`npm start` starts a **local Wrangler preview** from the built Worker; it is not a production Node server. Managed Linux builds also use the bounded wrapper in `scripts/build-verified.sh`, which requires GNU `timeout`.

The repository currently has no `npm test` script. Record manual checks and the exact commit SHA instead of claiming an automated application test suite exists.

## 4. Publish through the existing Sites project

From a connected Sites workflow:

1. Select the project ID from `.openai/hosting.json` and confirm its current production version.
2. Configure the five runtime variables/secrets on the Site. Local `.env` values do not automatically become production secrets.
3. Push the exact reviewed source through the Sites source-repository workflow, build its artifact, and save the version associated with that source SHA.
4. Confirm the D1 binding is `DB`. The build includes `dist/.openai/drizzle` so the Sites deployment workflow can apply migrations; inspect the deployment result before assuming the schema is current.
5. Deploy that saved version and wait for a successful production deployment.
6. Confirm the production OAuth callback and connect Google Drive from the admin workspace.
7. Preserve the existing site audience and verify the application access controls.

A GitHub push by itself is not documented here as an automatic Sites deployment trigger. There is no checked-in GitHub Actions job that publishes this project. Do not run a generic Vercel or static Pages deployment and expect the Cloudflare bindings to exist.

## Acceptance checks

- Host login works with valid credentials and rejects an invalid password.
- A test event can be created and changed between draft/live/paused states.
- Host uploads arrive in the connected Drive and metadata persists after reload.
- Guest access respects the event's link/password mode.
- Guest uploads obey moderation and download settings.
- QR links, slideshow, original download, and event deletion behave as expected.
- Private media remains inaccessible without the required session.

Use a disposable test event and remove its media after checking. Purchases and paid plans remain disabled while the project is in testing.

## iOS host shell

Open `ios/SnapHUB/SnapHUB.xcodeproj`, select your own signing team, and inspect `AppConfig.swift` for the intended site origin. Build and run the `SnapHUB` scheme on a simulator or trusted physical iPhone/iPad. App Store/TestFlight distribution requires the owner's Apple signing and App Store Connect setup.

## Recovery and troubleshooting

| Symptom | Check |
| --- | --- |
| Missing `DB` binding | `hosting.json`, generated Worker config, and Sites bindings |
| Missing tables | Migration application and target database |
| OAuth redirect mismatch | Exact scheme, hostname, port, and callback path |
| Drive unavailable | OAuth client configuration, consent, and host connection |
| Invalid sessions or token decryption | Runtime `SESSION_SECRET` consistency |
| Build wrapper fails early | Node version, installed dependencies, GNU `timeout`, and wrapper logs |

Changing `SESSION_SECRET` invalidates sessions and can require reconnecting Google Drive because stored tokens are protected using that secret. Plan rotation accordingly.

Before a release, retain the previous source SHA and Sites version and back up D1 data. Redeploy a known compatible saved version if necessary. A code rollback does not reverse database migrations or restore deleted Google Drive media; assess data compatibility before rollback.
