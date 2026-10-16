#!/usr/bin/env node
// Copies every MongoDB collection into the MySQL database (prisma/schema.prisma).
//
//   node scripts/migrate-mongo-to-mysql.js --yes            wipe MySQL tables, then import everything
//   node scripts/migrate-mongo-to-mysql.js --yes posts,users import only these Mongo collections
//   node scripts/migrate-mongo-to-mysql.js --dry-run         count documents only
//
// Source: MIGRATE_MONGO_URI, else MONGODB_URI / PROD_MONGODB_URI from .env.
// Target: DATABASE_URL. Re-run it right before the cutover so MySQL has the
// latest data; every run replaces the target tables' contents.
//
// Mongo ObjectIds are kept as 24-char hex ids. Reference arrays become join
// tables (see the conventions in prisma/schema.prisma).
const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
// Same workaround as index.js: local resolvers often refuse mongodb+srv lookups.
if (process.env.USE_PUBLIC_DNS !== "false") {
  try {
    require("dns").setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
  } catch (_) {
    /* ignore if unsupported */
  }
}
const { MongoClient, ObjectId } = require("mongodb");
const { Prisma } = require("@prisma/client");
const { prisma } = require("../config/prisma");
const { newId } = require("../utils/objectId");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const CONFIRMED = args.includes("--yes");
const ONLY = args.find((a) => !a.startsWith("--"));
const ONLY_SET = ONLY ? new Set(ONLY.split(",").map((s) => s.trim())) : null;
const BATCH = 500;

const MONGO_URI =
  process.env.MIGRATE_MONGO_URI || process.env.MONGODB_URI || process.env.PROD_MONGODB_URI;

// ─── value conversion ───────────────────────────────────────────────

const isObjectId = (v) =>
  v instanceof ObjectId || (v && typeof v === "object" && v._bsontype === "ObjectId");

const idOf = (v) => {
  if (v == null) return null;
  if (isObjectId(v)) return v.toHexString();
  if (typeof v === "object" && v._id != null) return idOf(v._id);
  return String(v);
};

/** Make a Mongo value JSON-safe for a Json column (ObjectId -> hex, Date -> ISO, Map -> object). */
function toJson(v) {
  if (v == null) return v;
  if (isObjectId(v)) return v.toHexString();
  if (v instanceof Date) return isNaN(v) ? null : v.toISOString();
  if (v instanceof Map) return Object.fromEntries([...v].map(([k, x]) => [k, toJson(x)]));
  if (Array.isArray(v)) return v.map(toJson);
  if (typeof v === "object") {
    if (v._bsontype === "Decimal128" || v._bsontype === "Long" || v._bsontype === "Double") return Number(v.toString());
    if (v._bsontype === "Binary") return v.toString("base64");
    const out = {};
    for (const [k, x] of Object.entries(v)) out[k] = toJson(x);
    return out;
  }
  if (typeof v === "number" && !Number.isFinite(v)) return null;
  return v;
}

const varcharLimit = (field) => {
  const nt = field.nativeType;
  if (!nt) return 191; // Prisma's default String column on MySQL
  if (nt[0] === "VarChar" || nt[0] === "Char") return Number(nt[1]?.[0]) || 191;
  return null; // Text / MediumText
};

function coerce(field, value) {
  if (value === undefined) return undefined;
  if (value === null) return null;
  switch (field.type) {
    case "String": {
      let s = isObjectId(value) ? value.toHexString()
        : value instanceof Date ? value.toISOString()
        : typeof value === "object" ? JSON.stringify(toJson(value))
        : String(value);
      const limit = varcharLimit(field);
      if (limit && s.length > limit) s = s.slice(0, limit);
      return s;
    }
    case "Int": {
      const n = Math.round(Number(value));
      return Number.isFinite(n) ? n : null;
    }
    case "Float": {
      const n = value instanceof Date ? value.getTime() : Number(value);
      return Number.isFinite(n) ? n : null;
    }
    case "Boolean":
      return value === true || value === "true" || value === 1;
    case "DateTime": {
      const d = value instanceof Date ? value : new Date(value);
      return isNaN(d) ? null : d;
    }
    case "Json":
      return toJson(value);
    default:
      return value;
  }
}

function fallbackFor(field) {
  switch (field.type) {
    case "String": return "";
    case "Int":
    case "Float": return 0;
    case "Boolean": return false;
    case "DateTime": return new Date();
    default: return undefined;
  }
}

const MODELS = Object.fromEntries(Prisma.dmmf.datamodel.models.map((m) => [m.name, m]));

/** Map a Mongo document onto a model's scalar columns. `extra` overrides fields. */
function toRow(modelName, doc, extra = {}) {
  const model = MODELS[modelName];
  const source = { ...doc, id: idOf(doc._id), ...extra };
  const row = {};
  for (const field of model.fields) {
    if (field.kind !== "scalar" && field.kind !== "enum") continue;
    if (field.name === "_id") continue;
    let value = coerce(field, source[field.name]);
    if (value == null && field.isRequired) {
      if (field.hasDefaultValue) value = undefined; // let the column default apply
      else value = fallbackFor(field);
    }
    if (value !== undefined) row[field.name] = value === null && field.type === "Json" ? Prisma.DbNull : value;
  }
  if (!row.id) row.id = newId();
  return row;
}

// ─── per-collection handlers ────────────────────────────────────────

const joinRows = (list, build) =>
  (Array.isArray(list) ? list : []).map(build).filter(Boolean);

const aiFields = (ai = {}) => ({
  aiStatus: ai.status,
  aiCategories: ai.categories,
  aiEmbedding: ai.embedding,
  aiEmbeddingModel: ai.embeddingModel,
  aiProvider: ai.provider,
  aiContentHash: ai.contentHash,
  aiSentiment: ai.sentiment,
  aiContentSafetyFlags: ai.contentSafetyFlags,
  aiProcessedAt: ai.processedAt,
  aiError: ai.error,
});

// Comment parent ids collected from posts / watches / stories `comments` arrays,
// applied when the comments collection is imported.
const commentParents = new Map();

// Mongo collection name -> { model, extra(doc), joins(doc) -> { modelName: rows[] } }
const COLLECTIONS = {
  users: { model: "User" },
  admins: { model: "Admin" },
  profiles: {
    model: "Profile",
    joins: (doc) => {
      const id = idOf(doc._id);
      return {
        ProfileConnect: joinRows(doc.connects, (c) => idOf(c) && { profile: id, connect: idOf(c) }),
        ConnectRequest: joinRows(doc.connectReqs, (r) => idOf(r) && { profile: id, requester: idOf(r) }),
        Follow: [
          ...joinRows(doc.following, (f) => idOf(f) && { follower: id, following: idOf(f) }),
          ...joinRows(doc.followers, (f) => idOf(f) && { follower: idOf(f), following: id }),
        ],
        Block: joinRows(doc.blockedUsers, (b) => idOf(b) && { profile: id, blocked: idOf(b) }),
      };
    },
  },
  relationships: { model: "Relationship" },
  settings: { model: "Setting" },
  faceencodings: { model: "FaceEncoding" },
  posts: {
    model: "Post",
    extra: (doc) => aiFields(doc.aiMetadata),
    joins: (doc) => {
      const id = idOf(doc._id);
      for (const c of doc.comments || []) commentParents.set(idOf(c), { post: id });
      return {
        PostMention: joinRows(doc.mentions, (m) => idOf(m) && { post: id, profile: idOf(m) }),
        PostReact: joinRows(doc.reacts, (r) => idOf(r?.profile) && { post: id, profile: idOf(r.profile), type: r.type ?? null }),
        PostShare: joinRows(doc.shares, (s) => idOf(s) && { post: id, profile: idOf(s) }),
        PostViewer: joinRows(doc.viewers, (v) => idOf(v) && { post: id, profile: idOf(v) }),
      };
    },
  },
  watches: {
    model: "Watch",
    extra: (doc) => aiFields(doc.aiMetadata),
    joins: (doc) => {
      const id = idOf(doc._id);
      for (const c of doc.comments || []) commentParents.set(idOf(c), { watch: id });
      return {
        WatchReact: joinRows(doc.reacts, (r) => idOf(r?.profile) && { watch: id, profile: idOf(r.profile), type: r.type ?? null }),
        WatchShare: joinRows(doc.shares, (s) => idOf(s) && { watch: id, profile: idOf(s) }),
      };
    },
  },
  stories: {
    model: "Story",
    joins: (doc) => {
      const id = idOf(doc._id);
      for (const c of doc.comments || []) commentParents.set(idOf(c), { story: id });
      return {
        StoryReact: joinRows(doc.reacts, (r) => idOf(r?.profile) && { story: id, profile: idOf(r.profile), type: r.type ?? null }),
        StorySeen: joinRows(doc.seenBy, (s) => idOf(s) && { story: id, profile: idOf(s) }),
      };
    },
  },
  // after posts / watches / stories so commentParents is filled
  comments: {
    model: "Comment",
    extra: (doc) => {
      const parent = commentParents.get(idOf(doc._id)) || {};
      return {
        post: parent.post ?? (doc.watch ? null : doc.post),
        watch: parent.watch ?? doc.watch,
        story: parent.story ?? null,
      };
    },
  },
  cmntreplies: { model: "CmntReply" },
  reports: { model: "Report" },
  messages: { model: "Message" },
  notifications: { model: "Notification" },
  aichats: { model: "AIChat" },
  aigeneratedposts: { model: "AIGeneratedPost" },
  aiautopostconfigs: { model: "AIAutoPostConfig" },
  aisettings: { model: "AiSettings" },
  userinterestprofiles: { model: "UserInterestProfile" },
  connects: { model: "Connect" },
  expocontrolaccesses: { model: "ExpoControlAccess" },
  monetizationsettings: { model: "MonetizationSettings" },
  portfolios: { model: "Portfolio" },
  transactions: { model: "Transaction" },
  coachingpurchases: { model: "CoachingPurchase" },
  coinrewards: { model: "CoinReward" },
  payoutrequests: { model: "PayoutRequest" },
  tips: { model: "Tip" },
  calendarevents: { model: "CalendarEvent" },
  flashcards: { model: "Flashcard" },
  habits: { model: "Habit" },
  notes: { model: "Note" },
  tasks: { model: "Task" },
  timersessions: { model: "TimerSession" },
  reminders: { model: "Reminder" },
  fitnessprofiles: { model: "FitnessProfile" },
  fitnessdailylogs: { model: "FitnessDailyLog" },
  meals: { model: "Meal" },
  weightlogs: { model: "WeightLog" },
  workoutlogs: { model: "WorkoutLog" },
  recoveryprofiles: { model: "RecoveryProfile" },
  recoverycheckins: { model: "RecoveryCheckIn" },
  recoverycravings: { model: "RecoveryCraving" },
  recoverylapses: { model: "RecoveryLapse" },
  recoverychatmessages: { model: "RecoveryChatMessage" },
  ludogames: {
    model: "LudoGame",
    extra: (doc) => ({
      playerProfileIds: (doc.players || []).map((p) => idOf(p?.profileId)).filter(Boolean),
    }),
  },
  savedvideos: { model: "SavedVideo" },
  videoplaylists: { model: "VideoPlaylist" },
  ytdownloadprogresses: { model: "YtDownloadProgress" },
};

const JOIN_MODELS_OF = {
  profiles: ["ProfileConnect", "ConnectRequest", "Follow", "Block"],
  posts: ["PostMention", "PostReact", "PostShare", "PostViewer"],
  watches: ["WatchReact", "WatchShare"],
  stories: ["StoryReact", "StorySeen"],
};

const delegate = (modelName) => prisma[modelName[0].toLowerCase() + modelName.slice(1)];

async function insert(modelName, rows) {
  if (!rows.length) return 0;
  const shaped = rows.map((r) => (r.id ? r : toRow(modelName, {}, r)));
  let inserted = 0;
  for (let i = 0; i < shaped.length; i += BATCH) {
    const res = await delegate(modelName).createMany({ data: shaped.slice(i, i + BATCH), skipDuplicates: true });
    inserted += res.count;
  }
  return inserted;
}

async function migrateCollection(db, name, spec) {
  const total = await db.collection(name).estimatedDocumentCount();
  if (DRY_RUN) {
    console.log(`${name.padEnd(24)} ${String(total).padStart(8)} docs -> ${spec.model}`);
    return;
  }

  await delegate(spec.model).deleteMany({});
  for (const j of JOIN_MODELS_OF[name] || []) await delegate(j).deleteMany({});

  const cursor = db.collection(name).find({}, { batchSize: BATCH });
  let rows = [];
  const joins = {};
  let read = 0;
  let written = 0;
  let joinWritten = 0;

  const flush = async () => {
    written += await insert(spec.model, rows);
    rows = [];
    for (const [model, list] of Object.entries(joins)) {
      joinWritten += await insert(model, list);
      joins[model] = [];
    }
  };

  for await (const doc of cursor) {
    read++;
    rows.push(toRow(spec.model, doc, spec.extra ? spec.extra(doc) : {}));
    if (spec.joins) {
      for (const [model, list] of Object.entries(spec.joins(doc))) {
        (joins[model] ||= []).push(...list);
      }
    }
    if (rows.length >= BATCH) await flush();
  }
  await flush();

  const skipped = read - written;
  console.log(
    `${name.padEnd(24)} ${String(written).padStart(8)} / ${read} rows` +
      (joinWritten ? `  + ${joinWritten} join rows` : "") +
      (skipped ? `  (${skipped} skipped as duplicates)` : ""),
  );
}

async function main() {
  if (!MONGO_URI) throw new Error("Set MIGRATE_MONGO_URI (or MONGODB_URI) to the MongoDB source");
  if (!process.env.DATABASE_URL) throw new Error("Set DB_HOST, DB_NAME, DB_USER, DB_PASSWORD (or DATABASE_URL) for the MySQL target");
  if (!DRY_RUN && !CONFIRMED) {
    console.error("This replaces the contents of the MySQL tables. Re-run with --yes (or use --dry-run).");
    process.exit(1);
  }

  const client = new MongoClient(MONGO_URI, { serverSelectionTimeoutMS: 20000, family: 4 });
  await client.connect();
  const db = client.db();
  const existing = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  console.log(`Mongo database "${db.databaseName}" -> MySQL ${process.env.DATABASE_URL.replace(/:[^:@/]*@/, ":***@")}`);

  const unknown = [...existing].filter((c) => !COLLECTIONS[c] && !c.startsWith("system."));
  if (unknown.length) console.warn(`Not migrated (no matching model): ${unknown.join(", ")}`);

  for (const [name, spec] of Object.entries(COLLECTIONS)) {
    if (ONLY_SET && !ONLY_SET.has(name)) continue;
    if (!existing.has(name)) continue;
    await migrateCollection(db, name, spec);
  }

  await client.close();
  await prisma.$disconnect();
  console.log(DRY_RUN ? "Dry run finished." : "Migration finished.");
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
