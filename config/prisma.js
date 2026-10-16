// Shared Prisma client for the MySQL database (DB_HOST, DB_PORT, DB_NAME,
// DB_USER, DB_PASSWORD — or a full DATABASE_URL; see config/databaseUrl.js).
// Require this module instead of creating new PrismaClient instances so the
// whole process shares one connection pool.
//
// The client is extended so rows keep their Mongo shape:
// - every result has a computed `_id` equal to `id` (nested includes too), so
//   API responses and socket payloads that read `_id` keep working
// - top-level create / createMany / upsert fill `id` with a new ObjectId-style
//   hex string when none is given. Nested creates should pass `id: newId()`;
//   otherwise the schema's cuid() default applies.
const { PrismaClient } = require("@prisma/client");
const { applyDatabaseUrl } = require("./databaseUrl");

// Before the client is created: it reads DATABASE_URL at construction.
applyDatabaseUrl();
const { newId } = require("../utils/objectId");

const withId = (data) =>
  data && typeof data === "object" && data.id == null ? { ...data, id: newId() } : data;

const isPlainObject = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date);

// A computed field is only returned for a `select` that names it, so every
// selection that picks `id` also picks `_id` (nested relation selects too).
// Without this, `select: { id: true, ... }` rows would lose their `_id`.
function addComputedIdToSelects(args) {
  if (!isPlainObject(args)) return;
  if (isPlainObject(args.select)) {
    const selection = args.select;
    if (selection.id === true && !("_id" in selection)) selection._id = true;
    for (const [key, value] of Object.entries(selection)) {
      if (key !== "_count" && isPlainObject(value)) addComputedIdToSelects(value);
    }
  }
  if (isPlainObject(args.include)) {
    for (const [key, value] of Object.entries(args.include)) {
      if (key !== "_count" && isPlainObject(value)) addComputedIdToSelects(value);
    }
  }
}

// Operations whose `select` describes rows (not counts / aggregates).
const ROW_OPERATIONS = new Set([
  "findUnique",
  "findUniqueOrThrow",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "create",
  "createManyAndReturn",
  "update",
  "updateManyAndReturn",
  "upsert",
  "delete",
]);

const base = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
});

const prisma = base.$extends({
  result: {
    $allModels: {
      _id: {
        needs: { id: true },
        compute: (row) => row.id,
      },
    },
  },
  query: {
    $allModels: {
      $allOperations({ operation, args, query }) {
        if (ROW_OPERATIONS.has(operation)) addComputedIdToSelects(args);
        return query(args);
      },
      create({ args, query }) {
        args.data = withId(args.data);
        return query(args);
      },
      createMany({ args, query }) {
        args.data = Array.isArray(args.data) ? args.data.map(withId) : withId(args.data);
        return query(args);
      },
      upsert({ args, query }) {
        args.create = withId(args.create);
        return query(args);
      },
    },
  },
});

let mysqlReady = false;

async function connectMySQL() {
  if (!process.env.DATABASE_URL) {
    console.warn("DB_HOST / DB_NAME (or DATABASE_URL) are not set — MySQL (Prisma) is disabled");
    return false;
  }
  try {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
    mysqlReady = true;
    console.log("MySQL connected (Prisma)");
  } catch (e) {
    mysqlReady = false;
    console.error("MySQL connection failed (Prisma):", e.message || e);
  }
  return mysqlReady;
}

const isMySQLReady = () => mysqlReady;

module.exports = { prisma, connectMySQL, isMySQLReady };
