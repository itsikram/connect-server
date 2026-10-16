#!/usr/bin/env node
// Runs the Prisma CLI with DATABASE_URL built from DB_HOST / DB_PORT / DB_NAME /
// DB_USER / DB_PASSWORD (see config/databaseUrl.js).
// Usage: node scripts/prisma.js db push
const path = require("path");
const { spawnSync } = require("child_process");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { applyDatabaseUrl } = require("../config/databaseUrl");

applyDatabaseUrl();
const result = spawnSync("npx", ["prisma", ...process.argv.slice(2)], {
  cwd: path.join(__dirname, ".."),
  stdio: "inherit",
  shell: process.platform === "win32",
  env: process.env,
});
process.exit(result.status ?? 1);
