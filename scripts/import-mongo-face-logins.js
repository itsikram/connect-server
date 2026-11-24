#!/usr/bin/env node
// One-off: copy face-login encodings from the old MongoDB `faceLogins`
// collection (written by the Python face service) into MySQL `faceencodings`.
// Both come from the same dlib model, so registered users keep face login
// without registering again.
//
//   node scripts/import-mongo-face-logins.js --dry-run   show what would be imported
//   node scripts/import-mongo-face-logins.js             import
//
// Source: MIGRATE_MONGO_URI, else MONGODB_URI / PROD_MONGODB_URI from .env.
// Target: the MySQL database from DATABASE_URL / DB_* (config/prisma).
// Each document's `username` must belong to exactly one profile; others are
// skipped and listed. Profiles that already have a dlib encoding are kept.
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const { MongoClient } = require("mongodb");
const { prisma } = require("../config/prisma");
const { FACE_MODEL, isValidVector, toVector } = require("../utils/faceEncodingStore");

const DRY_RUN = process.argv.includes("--dry-run");
const MONGO_URI =
  process.env.MIGRATE_MONGO_URI || process.env.MONGODB_URI || process.env.PROD_MONGODB_URI;

const main = async () => {
  if (!MONGO_URI) throw new Error("Set MIGRATE_MONGO_URI (or MONGODB_URI) to the MongoDB that has faceLogins");
  const mongo = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 20000 });
  await mongo.connect();
  const summary = { found: 0, imported: 0, alreadyHad: 0, skipped: [] };
  try {
    const docs = await mongo.db().collection("faceLogins").find({}, { projection: { username: 1, encoding: 1 } }).toArray();
    summary.found = docs.length;
    for (const doc of docs) {
      const username = String(doc.username || "").trim();
      const vector = Array.isArray(doc.encoding) ? doc.encoding.map(Number) : null;
      if (!username || !isValidVector(vector)) {
        summary.skipped.push({ username, reason: "missing username or encoding" });
        continue;
      }
      const profiles = await prisma.profile.findMany({ where: { username }, select: { id: true }, take: 2 });
      if (profiles.length !== 1) {
        summary.skipped.push({ username, reason: profiles.length ? "username shared by several profiles" : "no profile" });
        continue;
      }
      const profile = String(profiles[0].id);
      const existing = await prisma.faceEncoding.findMany({ where: { profile }, select: { faceEncoding: true } });
      if (existing.some((row) => toVector(row.faceEncoding))) {
        summary.alreadyHad += 1;
        continue;
      }
      if (!DRY_RUN) {
        await prisma.faceEncoding.create({
          data: { name: username.slice(0, 191), profile, faceEncoding: { model: FACE_MODEL, vector } },
        });
      }
      summary.imported += 1;
    }
  } finally {
    await mongo.close();
    await prisma.$disconnect();
  }
  console.log(JSON.stringify({ dryRun: DRY_RUN, ...summary }, null, 2));
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
