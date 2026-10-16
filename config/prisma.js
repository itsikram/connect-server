// Shared Prisma client for the MySQL database (DATABASE_URL).
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
const { newId } = require("../utils/objectId");

const withId = (data) =>
  data && typeof data === "object" && data.id == null ? { ...data, id: newId() } : data;

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
    console.warn("DATABASE_URL is not set — MySQL (Prisma) is disabled");
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
