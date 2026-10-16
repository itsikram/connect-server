// Shared Prisma client for the MySQL database (DATABASE_URL).
// Require this module instead of creating new PrismaClient instances so the
// whole process shares one connection pool.
const { PrismaClient } = require("@prisma/client");

const prisma = new PrismaClient({
  log: process.env.NODE_ENV === "production" ? ["error"] : ["warn", "error"],
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
