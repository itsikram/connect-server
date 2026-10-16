// ObjectId-compatible ids without the mongodb driver: 4-byte unix seconds,
// 5 random per-process bytes, 3-byte counter, as 24 lowercase hex chars.
// New MySQL rows get the same id format the clients already see from Mongo.
const crypto = require("crypto");

const processUnique = crypto.randomBytes(5);
let counter = crypto.randomBytes(3).readUIntBE(0, 3);

function newId() {
  const buf = Buffer.alloc(12);
  buf.writeUInt32BE(Math.floor(Date.now() / 1000), 0);
  processUnique.copy(buf, 4);
  counter = (counter + 1) % 0xffffff;
  buf.writeUIntBE(counter, 9, 3);
  return buf.toString("hex");
}

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;

/** Replacement for mongoose.Types.ObjectId.isValid / isValidObjectId. */
function isValidId(value) {
  if (value == null) return false;
  const str = String(value);
  // Ids from the cuid() fallback are 25 chars of [a-z0-9].
  return OBJECT_ID_RE.test(str) || /^c[a-z0-9]{24}$/.test(str);
}

/** Creation time of an ObjectId-style id (replacement for ObjectId#getTimestamp). */
function idTimestamp(id) {
  const str = String(id || "");
  if (!OBJECT_ID_RE.test(str)) return null;
  return new Date(parseInt(str.slice(0, 8), 16) * 1000);
}

module.exports = { newId, isValidId, idTimestamp };
