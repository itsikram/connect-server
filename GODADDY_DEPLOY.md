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
   the database with all privileges, then set
   `DATABASE_URL=mysql://USER:PASSWORD@localhost:3306/DBNAME`. `npm install` runs
   `prisma generate`; create the tables once from cPanel **Terminal** with `npx prisma db push`.

## Notes / limits of shared hosting

- Do not set `PORT`; Passenger assigns it.
- PM2 / `ecosystem.config.js` / `load-balancer/` cannot be used; the app runs as a single process.
- If `mongodb+srv://` lookups fail, use the standard (non-SRV) connection string from Atlas.
- Socket.IO falls back to long-polling if WebSockets are not proxied by the host.
- yt-dlp/ffmpeg features may be restricted by the host's process and memory limits.
- Logs: `stderr.log` in the application root.
