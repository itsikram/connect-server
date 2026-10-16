// Helpers for porting Mongoose code to Prisma while keeping API payloads in
// the shape the web and Expo clients expect. See the conventions at the top
// of prisma/schema.prisma.
const { Prisma } = require("@prisma/client");
const { prisma } = require("../config/prisma");
const { newId, isValidId, idTimestamp } = require("./objectId");

/** String form of an id, a populated row, or a Mongo-style { _id } object. */
function toId(value) {
  if (value == null) return null;
  if (typeof value === "object") return toId(value.id ?? value._id);
  return String(value);
}

/** True when two ids (or rows) refer to the same record — replaces ObjectId#equals. */
function sameId(a, b) {
  const x = toId(a);
  return x != null && x === toId(b);
}

/**
 * Mongoose-populate shape: for each field, move row[`${field}Doc`] onto
 * row[field] (when it was included) so `post.author` is the profile object.
 * Works on a row or an array of rows; returns the same value.
 */
function populated(rows, ...fields) {
  const apply = (row) => {
    if (!row || typeof row !== "object") return row;
    for (const field of fields) {
      const key = `${field}Doc`;
      if (key in row) {
        row[field] = row[key];
        delete row[key];
      }
    }
    return row;
  };
  return Array.isArray(rows) ? rows.map(apply) : apply(rows);
}

/**
 * Join rows -> id list, e.g. pluck(post.shares, "profile") gives the old
 * `shares: [profileId]` array. Pass a Doc field name to get the populated objects.
 */
function pluck(rows, field) {
  return Array.isArray(rows) ? rows.map((row) => row?.[field]).filter((v) => v != null) : [];
}

/** Json column -> array, tolerating null / non-array values. */
function jsonArray(value) {
  return Array.isArray(value) ? value : [];
}

/** Json column -> plain object, tolerating null / non-object values. */
function jsonObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/** Prisma "record not found" (P2025) — the old findByIdAndUpdate returned null. */
function isNotFound(err) {
  return err?.code === "P2025";
}

/** Unique-constraint violation (P2002) — the old Mongo E11000 duplicate key error. */
function isDuplicate(err) {
  return err?.code === "P2002";
}

/** Case-insensitive `contains` filter (replacement for { $regex, $options: "i" }). */
function containsInsensitive(text) {
  // MySQL's default utf8mb4 collations are already case-insensitive.
  return { contains: String(text ?? "") };
}

/**
 * Read-modify-write of a Profile Json array column (deviceTokens, browserIds,
 * webPushSubscriptions) — replaces $push / $pull / $addToSet on embedded arrays.
 * Returns the new array, or null when the profile does not exist.
 */
async function editProfileJsonArray(profileId, field, change) {
  return prisma.$transaction(async (tx) => {
    const row = await tx.profile.findUnique({ where: { id: String(profileId) }, select: { [field]: true } });
    if (!row) return null;
    const next = change(jsonArray(row[field]));
    await tx.profile.update({ where: { id: String(profileId) }, data: { [field]: next } });
    return next;
  });
}

const modelFieldCache = new Map();

/** Writable scalar / Json column names of a Prisma model (by model name, e.g. "Setting"). */
function modelFields(modelName) {
  if (!modelFieldCache.has(modelName)) {
    const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
    if (!model) throw new Error(`Unknown Prisma model ${modelName}`);
    const fields = model.fields.filter((f) => f.kind !== "object" && !f.isUpdatedAt);
    modelFieldCache.set(modelName, new Map(fields.map((f) => [f.name, f.type])));
  }
  return modelFieldCache.get(modelName);
}

/** Cast a request value to a column type, the way Mongoose casting did. */
function castToColumn(type, value) {
  if (value === null) return type === "Json" ? Prisma.DbNull : null;
  switch (type) {
    case "Boolean":
      if (typeof value === "string") {
        if (value === "true" || value === "1") return true;
        if (value === "false" || value === "0" || value === "") return false;
      }
      return typeof value === "number" ? value !== 0 : value;
    case "Int":
    case "Float": {
      if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
        return type === "Int" ? Math.trunc(Number(value)) : Number(value);
      }
      return value;
    }
    case "DateTime":
      return typeof value === "string" || typeof value === "number" ? new Date(value) : value;
    case "String":
      return typeof value === "number" || typeof value === "boolean" ? String(value) : value;
    default:
      return value;
  }
}

/**
 * Keep only keys that are columns of the model (Mongoose's strict mode
 * silently dropped unknown paths; Prisma rejects them). `id`, `createdAt`
 * are dropped too unless listed in `keep`.
 */
function pickModelFields(modelName, data, { keep = [] } = {}) {
  const fields = modelFields(modelName);
  const out = {};
  for (const [key, value] of Object.entries(data || {})) {
    if (value === undefined) continue;
    if ((key === "id" || key === "_id" || key === "createdAt") && !keep.includes(key)) continue;
    if (fields.has(key)) out[key] = castToColumn(fields.get(key), value);
  }
  return out;
}

module.exports = {
  Prisma,
  editProfileJsonArray,
  modelFields,
  pickModelFields,
  prisma,
  newId,
  isValidId,
  idTimestamp,
  toId,
  sameId,
  populated,
  pluck,
  jsonArray,
  jsonObject,
  isNotFound,
  isDuplicate,
  containsInsensitive,
};
