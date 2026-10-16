// Helpers for porting Mongoose code to Prisma while keeping API payloads in
// the shape the web and Expo clients expect. See the conventions at the top
// of prisma/schema.prisma.
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

module.exports = {
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
