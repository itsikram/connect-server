// Face-login encodings live in this server's MySQL database (table
// `faceencodings`, Prisma model FaceEncoding). The hosted face service only
// checks liveness and computes the encoding (POST /api/face/encode); storing,
// duplicate checks and matching happen here.
//
// The table also holds rows from the old face-api.js login, whose numbers
// come from a different model and must never be compared with these. New
// rows are stored as { model, vector } and only those are matched.

const FACE_MODEL = "dlib_resnet_v1";
// Same threshold the Python service used: lower is stricter.
// face_recognition's own default is 0.6.
const MATCH_TOLERANCE = 0.5;
const VECTOR_LENGTH = 128;

const toVector = (value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  if (value.model !== FACE_MODEL || !Array.isArray(value.vector)) return null;
  if (value.vector.length !== VECTOR_LENGTH) return null;
  const vector = value.vector.map(Number);
  return vector.every(Number.isFinite) ? vector : null;
};

const isValidVector = (vector) =>
  Array.isArray(vector) && vector.length === VECTOR_LENGTH && vector.every((n) => Number.isFinite(Number(n)));

const distance = (a, b) => {
  let sum = 0;
  for (let i = 0; i < VECTOR_LENGTH; i += 1) {
    const d = a[i] - b[i];
    sum += d * d;
  }
  return Math.sqrt(sum);
};

/** All face-login encodings that belong to a profile: [{ profile, vector }]. */
const loadEncodings = async (prisma) => {
  const rows = await prisma.faceEncoding.findMany({
    where: { profile: { not: null } },
    select: { profile: true, faceEncoding: true },
  });
  return rows
    .map((row) => ({ profile: String(row.profile), vector: toVector(row.faceEncoding) }))
    .filter((row) => row.vector);
};

/** Closest stored face within tolerance, or null: { profile, distance }. */
const findBestMatch = (vector, entries, tolerance = MATCH_TOLERANCE) => {
  let best = null;
  for (const entry of entries) {
    const d = distance(vector, entry.vector);
    if (d <= tolerance && (!best || d < best.distance)) best = { profile: entry.profile, distance: d };
  }
  return best;
};

/** Replace this profile's face data with one new encoding. */
const saveEncoding = async (prisma, { profileId, name, vector }) => {
  const profile = String(profileId);
  await prisma.$transaction([
    prisma.faceEncoding.deleteMany({ where: { profile } }),
    prisma.faceEncoding.create({
      data: {
        name: String(name || profile).slice(0, 191),
        profile,
        faceEncoding: { model: FACE_MODEL, vector: vector.map((n) => Number(n)) },
      },
    }),
  ]);
};

const removeEncodings = (prisma, profileId) =>
  prisma.faceEncoding.deleteMany({ where: { profile: String(profileId) } });

module.exports = {
  FACE_MODEL,
  MATCH_TOLERANCE,
  distance,
  findBestMatch,
  isValidVector,
  loadEncodings,
  removeEncodings,
  saveEncoding,
  toVector,
};
