# Deploying to GoDaddy Deluxe Node.js hosting

GoDaddy Deluxe runs Node apps through cPanel **Setup Node.js App** (Phusion Passenger).
Shared hosting has no compiler, so this branch drops native modules that fail to build there:

- `bcrypt` → `bcryptjs` (pure JS; existing password hashes still verify)
- Removed unused `canvas`, `@tensorflow/tfjs`, `@tensorflow/tfjs-node`, `@vladmandic/face-api`
- `app.js` is the Passenger startup file; it defaults `NODE_ENV=production` and `USE_PUBLIC_DNS=false`

## Automatic deploys from GitHub

This app runs on GoDaddy's managed Node.js hosting (host.godaddy.com → My Apps →
**connect-server**, app ID `oeazgm4zwn`), with **Settings → Integrations → GitHub Sync** pointed at
this repo's `web-hosting-delux-compatible` branch.

`.github/workflows/deploy-godaddy.yml` runs on every push to `web-hosting-delux-compatible`, after `npm run test:ci` passes (`main` still targets MongoDB/Redis hosting and is not deployed here) and calls
the GoDaddy Hosting API: it imports the branch through GitHub Sync (what
**Update Preview** does), waits for the preview build, then publishes it (what
**Publish to Live** does). GoDaddy builds and runs the app itself, so build and
runtime environment values belong in the app's **Settings → Secrets** on
GoDaddy, not in GitHub.

### One-time setup

1. developer.godaddy.com → **Personal Access Tokens**: create a token with the
   scopes `hosting.application:read`, `hosting.source:write` and
   `hosting.deployment:execute`. One token can serve all your apps.
2. GitHub → this repo → Settings → Secrets and variables → **Actions** → New
   repository secret: name `GODADDY_PAT`, value the token.
3. Push to `web-hosting-delux-compatible`, or run the workflow from the **Actions** tab.

### Rollback

GitHub Sync always imports the head of `web-hosting-delux-compatible`, so re-running an old workflow
run publishes the current code. To roll back, `git revert` the bad commit and
push.

## Notes / limits of shared hosting

- Do not set `PORT`; Passenger assigns it.
- PM2 / `ecosystem.config.js` / `load-balancer/` cannot be used; the app runs as a single process.
- If `mongodb+srv://` lookups fail, use the standard (non-SRV) connection string from Atlas.
- Socket.IO falls back to long-polling if WebSockets are not proxied by the host.
- yt-dlp/ffmpeg features may be restricted by the host's process and memory limits.
- Logs: `stderr.log` in the application root.
