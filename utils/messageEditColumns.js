// Live databases are not migrated automatically, and every message query
// selects the edit columns, so add them before the API reports MySQL ready.
// Matches what `prisma db push` generates for Message.isEdited / editedAt.
const COLUMNS = {
  isEdited: "ADD COLUMN `isEdited` BOOLEAN NOT NULL DEFAULT false",
  editedAt: "ADD COLUMN `editedAt` DATETIME(3) NULL",
};

const ensureMessageEditColumns = async (prisma) => {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'",
  );
  const existing = new Set(rows.map((row) => String(row.name)));
  const missing = Object.keys(COLUMNS).filter((name) => !existing.has(name));
  if (!missing.length) return [];
  await prisma.$executeRawUnsafe(
    `ALTER TABLE \`messages\` ${missing.map((name) => COLUMNS[name]).join(", ")}`,
  );
  console.log(`[messages] added edit column(s): ${missing.join(", ")}`);
  return missing;
};

module.exports = { ensureMessageEditColumns };
