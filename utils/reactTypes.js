const REACT_TYPES = ["like", "love", "haha", "wow", "sad", "angry"];

const isValidReactType = (type) =>
  REACT_TYPES.includes(String(type || "").toLowerCase());

const normalizeReactType = (type) => {
  const normalized = String(type || "").toLowerCase().trim();
  return isValidReactType(normalized) ? normalized : null;
};

module.exports = {
  REACT_TYPES,
  isValidReactType,
  normalizeReactType,
};
