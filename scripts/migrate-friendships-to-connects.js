#!/usr/bin/env node
/*
 * Safe, copy-only preparation for the embedded friendship rebrand.
 *
 * Required: MONGODB_URI (or MONGO_URI). Optional: DB_NAME and PROFILE_COLLECTION.
 * By default this copies profiles to a timestamped staging collection, renames
 * fields only in staging, and verifies the result. Live profiles are untouched.
 * To cut over live data, set LIVE_CUTOVER_CONFIRM exactly to
 * "I_UNDERSTAND_LIVE_CUTOVER".
 */
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

const uri = process.env.MONGODB_URI || process.env.MONGO_URI;
if (!uri) throw new Error("Set MONGODB_URI (or MONGO_URI) before running this script.");

const profileName = process.env.PROFILE_COLLECTION || "profiles";
const dbName = process.env.DB_NAME;
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const stagingName = process.env.STAGING_COLLECTION || `profiles_connects_staging_${stamp}`;
const backupDir = path.join(__dirname, "migration-backups", `profiles-connects-${stamp}`);
const liveCutover = process.env.LIVE_CUTOVER_CONFIRM === "I_UNDERSTAND_LIVE_CUTOVER";
if (stagingName === profileName) {
  throw new Error("STAGING_COLLECTION must differ from PROFILE_COLLECTION.");
}
fs.mkdirSync(backupDir, { recursive: true });

const fieldSample = (docs) => docs.slice(0, 3).map((doc) => ({
  _id: doc._id,
  friends: Array.isArray(doc.friends) ? doc.friends.length : undefined,
  friendReqs: Array.isArray(doc.friendReqs) ? doc.friendReqs.length : undefined,
  connects: Array.isArray(doc.connects) ? doc.connects.length : undefined,
  connectReqs: Array.isArray(doc.connectReqs) ? doc.connectReqs.length : undefined,
}));

async function main() {
  await mongoose.connect(uri, dbName ? { dbName } : undefined);
  try {
    const db = mongoose.connection.db;
    const profiles = db.collection(profileName);
    const staging = db.collection(stagingName);
    const audit = db.collection("connects_migration_audit");

    const sourceDocs = await profiles.find({}).toArray();
    const sourceCount = sourceDocs.length;
    const sourceLegacyCount = await profiles.countDocuments({
      $or: [{ friends: { $exists: true } }, { friendReqs: { $exists: true } }],
    });
    const sourceConnectCount = await profiles.countDocuments({
      $or: [{ connects: { $exists: true } }, { connectReqs: { $exists: true } }],
    });
    if (sourceConnectCount) {
      throw new Error(
        `Source already contains ${sourceConnectCount} connect-field documents; refusing to risk an overwrite.`,
      );
    }
    fs.writeFileSync(path.join(backupDir, `${profileName}.json`), JSON.stringify(sourceDocs, null, 2));
    fs.writeFileSync(path.join(backupDir, "manifest.json"), JSON.stringify({
      createdAt: new Date().toISOString(),
      profileName,
      stagingName,
      sourceCount,
      sourceLegacyCount,
      liveCutover,
      sourceSample: fieldSample(sourceDocs),
    }, null, 2));

    const existingStagingCount = await staging.countDocuments();
    if (existingStagingCount) {
      throw new Error(`${stagingName} already contains ${existingStagingCount} documents; refusing to overwrite.`);
    }
    if (sourceDocs.length) await staging.insertMany(sourceDocs, { ordered: true });

    const stagingCountBeforeRename = await staging.countDocuments();
    const sourceIds = sourceDocs.map((doc) => String(doc._id)).sort();
    const stagingIds = (await staging.find({}, { projection: { _id: 1 } }).toArray())
      .map((doc) => String(doc._id)).sort();
    if (sourceCount !== stagingCountBeforeRename ||
        JSON.stringify(sourceIds) !== JSON.stringify(stagingIds)) {
      throw new Error(`Staging verification failed: source=${sourceCount}, staging=${stagingCountBeforeRename}, IDs differ.`);
    }

    const stagingRename = await staging.updateMany(
      { $or: [{ friends: { $exists: true } }, { friendReqs: { $exists: true } }] },
      { $rename: { friends: "connects", friendReqs: "connectReqs" } },
    );
    const stagingLegacyCount = await staging.countDocuments({
      $or: [{ friends: { $exists: true } }, { friendReqs: { $exists: true } }],
    });
    const stagingConnectCount = await staging.countDocuments({
      $or: [{ connects: { $exists: true } }, { connectReqs: { $exists: true } }],
    });
    if (stagingLegacyCount || sourceLegacyCount !== stagingConnectCount) {
      throw new Error(`Staging field verification failed: legacy=${stagingLegacyCount}, connects=${stagingConnectCount}.`);
    }
    const stagingDocs = await staging.find({}).limit(3).toArray();
    const sourceSample = fieldSample(sourceDocs);
    const stagingSample = fieldSample(stagingDocs);
    const sampleMatches = sourceSample.length === stagingSample.length &&
      sourceSample.every((source, index) => {
        const staged = stagingSample[index];
        return String(source._id) === String(staged._id) &&
          (source.friends || 0) === (staged.connects || 0) &&
          (source.friendReqs || 0) === (staged.connectReqs || 0);
      });
    if (!sampleMatches) {
      throw new Error("Staging sample verification failed: relationship field values differ.");
    }

    let liveRename = null;
    if (liveCutover) {
      liveRename = await profiles.updateMany(
        { $or: [{ friends: { $exists: true } }, { friendReqs: { $exists: true } }] },
        { $rename: { friends: "connects", friendReqs: "connectReqs" } },
      );
    }

    const auditRecord = {
      migration: "embedded-friendships-to-connects",
      completedAt: new Date(),
      profileName,
      stagingName,
      sourceCount,
      stagingCount: stagingCountBeforeRename,
      stagingRenameMatched: stagingRename.matchedCount,
      stagingRenameModified: stagingRename.modifiedCount,
      stagingLegacyCount,
      stagingConnectCount,
      liveCutover,
      liveRenameMatched: liveRename?.matchedCount || 0,
      liveRenameModified: liveRename?.modifiedCount || 0,
      backupDir,
      sourceSample,
      stagingSample,
    };
    await audit.insertOne(auditRecord);
    console.log(JSON.stringify(auditRecord, null, 2));
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
