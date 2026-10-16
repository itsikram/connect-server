// One-off data import for copying a database onto another server
// (used by scripts/push-data-to-live.js). Disabled unless DATA_IMPORT_SECRET
// is set to at least 24 characters; every request must send the same value in
// the X-Data-Import-Secret header. Remove the variable once the import is done.
//
//   GET    /api/data-import/status    MySQL version + row count of every table
//   POST   /api/data-import/schema    create / update tables (prisma db push)
//   DELETE /api/data-import/:model    empty one table
//   POST   /api/data-import/:model    insert { rows: [...] } (existing ids are skipped)
const express = require("express");
const crypto = require("crypto");
const path = require("path");
const { spawn } = require("child_process");
const { Prisma, prisma } = require("../utils/db");

const router = express.Router();

const MODELS = new Map(Prisma.dmmf.datamodel.models.map((model) => [model.name, model]));
const delegateOf = (name) => prisma[name.charAt(0).toLowerCase() + name.slice(1)];

const secretMatches = (given) => {
  const expected = String(process.env.DATA_IMPORT_SECRET || "");
  const actual = String(given || "");
  if (expected.length < 24 || actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
};

router.use((req, res, next) => {
  if (String(process.env.DATA_IMPORT_SECRET || "").length < 24) {
    return res.status(404).json({ message: "Not found" });
  }
  if (!secretMatches(req.get("x-data-import-secret"))) {
    return res.status(401).json({ message: "Invalid data import secret" });
  }
  return next();
});

/** JSON row -> Prisma create data: ISO strings back to Dates, Json nulls explicit. */
const toCreateData = (model, row) => {
  const data = {};
  for (const field of model.fields) {
    if (field.kind === "object" || !(field.name in row)) continue;
    const value = row[field.name];
    if (field.type === "Json") {
      data[field.name] = value === null ? Prisma.DbNull : value;
    } else if (field.type === "DateTime") {
      data[field.name] = value === null ? null : new Date(value);
    } else {
      data[field.name] = value;
    }
  }
  return data;
};

const modelFromParam = (req, res) => {
  const model = MODELS.get(req.params.model);
  if (!model) res.status(404).json({ message: `Unknown model ${req.params.model}` });
  return model;
};

router.get("/status", async (req, res, next) => {
  try {
    const [{ version }] = await prisma.$queryRaw`SELECT VERSION() AS version`;
    const counts = {};
    for (const name of MODELS.keys()) {
      counts[name] = await delegateOf(name)
        .count()
        .catch((error) => `error: ${error.code || ""} ${String(error.message || "").split("\n").pop()}`.trim());
    }
    return res.json({ ok: true, mysqlVersion: version, counts });
  } catch (error) {
    return next(error);
  }
});

router.post("/schema", (req, res) => {
  // Same command as `npm run db:push`; refuses changes that would lose data.
  const child = spawn(process.execPath, [path.join(__dirname, "..", "scripts", "prisma.js"), "db", "push", "--skip-generate"], {
    cwd: path.join(__dirname, ".."),
    env: process.env,
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += chunk));
  child.stderr.on("data", (chunk) => (output += chunk));
  child.on("error", (error) => (output += `\n${error.message}`));
  child.on("close", (code) => {
    res.status(code === 0 ? 200 : 500).json({ ok: code === 0, code, output: output.slice(-6000) });
  });
});

router.delete("/:model", async (req, res) => {
  const model = modelFromParam(req, res);
  if (!model) return undefined;
  try {
    // Raw DELETE: relationMode "prisma" makes deleteMany refuse tables other
    // rows point at. The table name comes from the schema, never the request.
    const table = (model.dbName || model.name).replace(/`/g, "");
    const deleted = await prisma.$executeRawUnsafe(`DELETE FROM \`${table}\``);
    return res.json({ ok: true, model: model.name, deleted });
  } catch (error) {
    return res.status(500).json({ ok: false, code: error.code, message: String(error.message || "").slice(-1500) });
  }
});

router.post("/:model", async (req, res) => {
  const model = modelFromParam(req, res);
  if (!model) return undefined;
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : null;
  if (!rows) return res.status(400).json({ message: "Body must be { rows: [...] }" });
  try {
    // One INSERT per ~256 KB of rows: a statement over the server's
    // max_allowed_packet (often 1 MB on shared hosts) drops the connection.
    let inserted = 0;
    let chunk = [];
    let bytes = 0;
    const flush = async () => {
      if (!chunk.length) return;
      const { count } = await delegateOf(model.name).createMany({ data: chunk, skipDuplicates: true });
      inserted += count;
      chunk = [];
      bytes = 0;
    };
    for (const row of rows) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (chunk.length && bytes + size > 256 * 1024) await flush();
      chunk.push(toCreateData(model, row));
      bytes += size;
    }
    await flush();
    return res.json({ ok: true, model: model.name, received: rows.length, inserted });
  } catch (error) {
    return res.status(500).json({ ok: false, code: error.code, message: String(error.message || "").slice(-1500) });
  }
});

module.exports = router;
