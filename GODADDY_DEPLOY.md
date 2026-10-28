# Deploying to GoDaddy Deluxe (cPanel) Node.js hosting

GoDaddy Deluxe runs Node apps through cPanel **Setup Node.js App** (Phusion Passenger).
Shared hosting has no compiler, so this branch drops native modules that fail to build there:

- `bcrypt` → `bcryptjs` (pure JS; existing password hashes still verify)
- Removed unused `canvas`, `@tensorflow/tfjs`, `@tensorflow/tfjs-node`, `@vladmandic/face-api`
- `app.js` is the Passenger startup file; it defaults `NODE_ENV=production` and `USE_PUBLIC_DNS=false`

## Steps

1. Upload the project (without `node_modules`, `debug.log`, `bin/`) to e.g. `~/connect-server`,
   or clone this branch via cPanel **Git Version Control**.
2. cPanel → **Setup Node.js App** → **Create Application**
   - Node.js version: highest available (18 or newer)
   - Application mode: Production
   - Application root: `connect-server`
   - Application URL: your domain / subdomain
   - Application startup file: `app.js`
3. Add environment variables in the same screen (copy from your `.env`), or upload `.env`
   into the application root. At minimum: `PROD_MONGODB_URI` (or `MONGODB_URI`) and the keys you use.
4. Click **Run NPM Install**, then **Restart**.
5. MongoDB Atlas: allow the hosting server's IP under Network Access.
6. MySQL (Prisma): cPanel → **MySQL Databases**, create a database and user, add the user to
   the database with all privileges, then set `DB_HOST=localhost`, `DB_PORT=3306`,
   `DB_NAME`, `DB_USER` and `DB_PASSWORD`. `npm install` runs `prisma generate`; create the
   tables once from cPanel **Terminal** with `npm run db:push`.

## Automatic deploys from GitHub

`.github/workflows/deploy-godaddy.yml` deploys every push to
`web-hosting-delux-compatible` (`main` still targets MongoDB/Redis hosting and
is not deployed here): it runs
`npm run test:ci`, then over SSH uploads the files changed since the commit
that is live (recorded in `~/connect-server/.deploy-revision`), removes files
deleted in git, runs `npm install` inside the cPanel Node.js environment only
when `package.json` / `package-lock.json` changed, and restarts the app.
Files that are not in git (`.env`, `node_modules`, uploads, logs) are never
touched. Do the manual setup above once first; the workflow needs the app to
exist in **Setup Node.js App**.

### One-time setup

1. GoDaddy → My Products → Web Hosting → **Manage** → Settings → **SSH Access**:
   turn it on. Note the host (server IP or domain) and the cPanel username.
2. On your computer, create a key without a passphrase:
   `ssh-keygen -t ed25519 -N "" -C github-deploy -f godaddy_deploy`
3. cPanel → **SSH Access** → Manage SSH Keys → **Import Key**: paste
   `godaddy_deploy.pub`, then **Manage** → **Authorize** it.
4. Pin the host key: `ssh-keyscan -p 22 <host>` and keep the output.
5. GitHub → this repo → Settings → Secrets and variables → **Actions**:

   | Kind     | Name                      | Value                                                    |
   | -------- | ------------------------- | -------------------------------------------------------- |
   | Secret   | `GODADDY_SSH_HOST`        | server IP or domain                                      |
   | Secret   | `GODADDY_SSH_USER`        | cPanel username                                          |
   | Secret   | `GODADDY_SSH_KEY`         | contents of `godaddy_deploy` (the private key)           |
   | Secret   | `GODADDY_SSH_KNOWN_HOSTS` | output of step 4 (recommended)                           |
   | Secret   | `GODADDY_SSH_PORT`        | only if not 22                                           |
   | Variable | `GODADDY_APP_DIR`         | application root, relative to home, e.g. `connect-server` |
   | Variable | `GODADDY_HEALTHCHECK_URL` | e.g. `https://api.connect-bd.online/` (optional, checked after each deploy) |
   | Variable | `GODADDY_NODE_VERSION`    | Node.js version chosen in cPanel, used for tests (default `22`) |
   | Variable | `GODADDY_DB_PUSH`         | `true` to run `npm run db:push` when `prisma/` changes (needs the `DB_*` values in `.env` on the host) |

6. Push to `web-hosting-delux-compatible`.

Without `GODADDY_DB_PUSH`, a change under `prisma/` regenerates the Prisma
client and the run shows a warning; apply the schema yourself with
`npm run db:push` in cPanel **Terminal**.

### Manual runs and rollback

- To redeploy or roll back, open the run of the commit you want live
  (Actions → Deploy to GoDaddy) and click **Re-run all jobs**. Files added
  after that commit are removed again.
- GitHub only shows the **Run workflow** button (with *install_deps: always*
  to force `npm install` and *full_upload* to re-upload every tracked file)
  for workflows that are on the default branch. Until this workflow is on
  `main`, use the re-run above; to force a full upload, temporarily delete
  `~/connect-server/.deploy-revision` on the host and re-run.

## Notes / limits of shared hosting

- Do not set `PORT`; Passenger assigns it.
- PM2 / `ecosystem.config.js` / `load-balancer/` cannot be used; the app runs as a single process.
- If `mongodb+srv://` lookups fail, use the standard (non-SRV) connection string from Atlas.
- Socket.IO falls back to long-polling if WebSockets are not proxied by the host.
- yt-dlp/ffmpeg features may be restricted by the host's process and memory limits.
- Logs: `stderr.log` in the application root.
