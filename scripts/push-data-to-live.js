#!/usr/bin/env node
// Copies every table of the local MySQL database (DB_* in server/.env) to a
// server through its /api/data-import endpoint (Routes/dataImportRoutes.js).
//
//   node scripts/push-data-to-live.js --url https://example.com --status
//   node scripts/push-data-to-live.js --url https://example.com --schema
//   node scripts/push-data-to-live.js --url https://example.com --yes [--replace] [Post,User,...]
//
// --status   show the target's MySQL version and row counts, change nothing
// --schema   run `prisma db push` on the target before copying
// --replace  empty each target table before copying (otherwise rows whose id
//            already exists on the target are skipped)
// --yes      required for anything that writes to the target
//
// The secret comes from --secret or DATA_IMPORT_SECRET and must match the
// target's DATA_IMPORT_SECRET.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { Prisma, prisma } = require("../utils/db");

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
};
const BASE = String(option("url") || process.env.DATA_IMPORT_URL || "").replace(/\/+$/, "");
const SECRET = option("secret") || process.env.DATA_IMPORT_SECRET || "";
const ONLY = args.filter((arg, i) => !arg.startsWith("--") && !["--url", "--secret"].includes(args[i - 1]));
const MAX_BATCH_BYTES = 1024 * 1024;
const PAGE = 500;

const MODELS = Prisma.dmmf.datamodel.models.map((model) => model.name);
const delegateOf = (name) => prisma[name.charAt(0).toLowerCase() + name.slice(1)];

async function api(method, route, body) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const res = await fetch(`${BASE}/api/data-import${route}`, {
        method,
        headers: { "Content-Type": "application/json", "X-Data-Import-Secret": SECRET },
        body: body ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let data;
      try {
        data = JSON.parse(text);
      } catch (_e) {
        data = { message: text.slice(0, 300) };
      }
      if (!res.ok) throw Object.assign(new Error(`${method} ${route} -> ${res.status}: ${data.message || text.slice(0, 300)}`), { status: res.status, data });
      return data;
    } catch (error) {
      // Retry network hiccups and gateway errors, not real rejections.
      const retryable = !error.status || error.status >= 502;
      if (!retryable || attempt >= 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 2000 * attempt));
    }
  }
}

/** Local rows in id order, page by page; `_id` is dropped (computed field). */
async function* localRows(model) {
  let cursor = null;
  for (;;) {
    const rows = await delegateOf(model).findMany({
      orderBy: { id: "asc" },
      take: PAGE,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    for (const { _id, ...row } of rows) yield row;
    if (rows.length < PAGE) return;
    cursor = rows[rows.length - 1].id;
  }
}

async function pushModel(model) {
  if (flag("replace")) await api("DELETE", `/${model}`);
  let batch = [];
  let bytes = 0;
  let sent = 0;
  let inserted = 0;
  const flush = async () => {
    if (!batch.length) return;
    const result = await api("POST", `/${model}`, { rows: batch });
    sent += batch.length;
    inserted += result.inserted;
    batch = [];
    bytes = 0;
  };
  for await (const row of localRows(model)) {
    const size = Buffer.byteLength(JSON.stringify(row));
    if (batch.length && bytes + size > MAX_BATCH_BYTES) await flush();
    batch.push(row);
    bytes += size;
  }
  await flush();
  return { sent, inserted };
}

async function main() {
  if (!BASE) throw new Error("Pass --url https://your-server");
  if (SECRET.length < 24) throw new Error("Set DATA_IMPORT_SECRET (24+ characters) or pass --secret");

  const before = await api("GET", "/status");
  console.log(`Target ${BASE}  MySQL ${before.mysqlVersion}`);
  if (flag("status")) {
    for (const [model, count] of Object.entries(before.counts)) console.log(`  ${model.padEnd(22)} ${count}`);
    return;
  }
  if (!flag("yes")) throw new Error("This writes to the target database. Re-run with --yes (or use --status).");

  if (flag("schema")) {
    console.log("Running prisma db push on the target...");
    const result = await api("POST", "/schema");
    console.log(result.output.trim().split("\n").slice(-5).join("\n"));
  }

  const models = ONLY.length ? ONLY : MODELS;
  const unknown = models.filter((model) => !MODELS.includes(model));
  if (unknown.length) throw new Error(`Unknown models: ${unknown.join(", ")}`);

  const failures = [];
  for (const model of models) {
    const local = await delegateOf(model).count();
    try {
      const { sent, inserted } = local ? await pushModel(model) : { sent: 0, inserted: 0 };
      console.log(`${model.padEnd(22)} local ${String(local).padStart(5)}  sent ${String(sent).padStart(5)}  inserted ${String(inserted).padStart(5)}`);
    } catch (error) {
      failures.push(model);
      console.log(`${model.padEnd(22)} FAILED  ${error.message.slice(0, 400)}`);
    }
  }

  const after = await api("GET", "/status");
  const mismatched = [];
  for (const model of models) {
    const local = await delegateOf(model).count();
    if (after.counts[model] !== local) mismatched.push(`${model}: local ${local}, target ${after.counts[model]}`);
  }
  console.log(mismatched.length ? `\nRow counts differ:\n  ${mismatched.join("\n  ")}` : "\nRow counts match on every table.");
  if (failures.length || mismatched.length) process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
