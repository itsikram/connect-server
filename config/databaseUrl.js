// MySQL connection settings come from DB_HOST, DB_PORT, DB_NAME, DB_USER and
// DB_PASSWORD. Prisma (client and CLI) reads a single DATABASE_URL, so this
// builds it from those variables. When DB_HOST / DB_NAME are not set, an
// existing DATABASE_URL is used as-is.

function buildDatabaseUrl(env = process.env) {
  const host = String(env.DB_HOST || "").trim();
  const name = String(env.DB_NAME || "").trim();
  if (!host || !name) return null;
  const port = String(env.DB_PORT || "").trim() || "3306";
  const user = encodeURIComponent(String(env.DB_USER || "").trim());
  const password = encodeURIComponent(String(env.DB_PASSWORD ?? ""));
  const auth = user ? `${user}${password ? `:${password}` : ""}@` : "";
  return `mysql://${auth}${host}:${port}/${encodeURIComponent(name)}`;
}

/** Sets process.env.DATABASE_URL from the DB_* variables; returns the URL in use. */
function applyDatabaseUrl(env = process.env) {
  const url = buildDatabaseUrl(env);
  if (url) env.DATABASE_URL = url;
  return env.DATABASE_URL || null;
}

module.exports = { buildDatabaseUrl, applyDatabaseUrl };
