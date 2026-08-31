const MONGO_ID_RE = /^[a-fA-F0-9]{24}$/;

const asId = (value) => {
  if (value == null || value === "") return "";
  if (typeof value === "string") {
    const text = value.trim();
    return MONGO_ID_RE.test(text) ? text : "";
  }
  if (typeof value === "object") {
    if (
      typeof value.toHexString === "function" ||
      value._bsontype === "ObjectId"
    ) {
      const hex = String(value);
      return MONGO_ID_RE.test(hex) ? hex : "";
    }
    if (value._id) return asId(value._id);
    if (value.id) return asId(value.id);
  }
  const text = String(value || "").trim();
  return MONGO_ID_RE.test(text) ? text : "";
};

const idKey = (value) => {
  if (value == null || value === "") return "";
  if (typeof value === "object") {
    if (typeof value.toHexString === "function") {
      try {
        return String(value.toHexString());
      } catch (_e) {
        /* fall through */
      }
    }
    if (value._bsontype === "ObjectId") return String(value);
    if (value._id != null && value._id !== value) return idKey(value._id);
    if (value.id != null && typeof value.id !== "function" && value.id !== value) {
      return idKey(value.id);
    }
  }
  return String(value).trim();
};

const idsMatch = (left, right) => {
  const a = idKey(left);
  const b = idKey(right);
  return Boolean(a) && a === b;
};

const listHasId = (list, target) => {
  const wanted = idKey(target);
  if (!wanted || !Array.isArray(list)) return false;
  return list.some((item) => idKey(item) === wanted);
};

module.exports = { asId, idKey, idsMatch, listHasId };
