// Live databases are not migrated automatically, and every message query
// selects every Message column, so add the newer columns before the API
// reports MySQL ready. Matches what `prisma db push` generates for
// Message.isEdited / editedAt (POST /message/edit) and
// Message.isDelivered / deliveredAt (utils/messageStatus.js).
const COLUMNS = {
  isEdited: "ADD COLUMN `isEdited` BOOLEAN NOT NULL DEFAULT false",
  editedAt: "ADD COLUMN `editedAt` DATETIME(3) NULL",
  isDelivered: "ADD COLUMN `isDelivered` BOOLEAN NOT NULL DEFAULT false",
  deliveredAt: "ADD COLUMN `deliveredAt` DATETIME(3) NULL",
};

const ensureMessageColumns = async (prisma) => {
  const rows = await prisma.$queryRawUnsafe(
    "SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'messages'",
  );
  const existing = new Set(rows.map((row) => String(row.name)));
  const missing = Object.keys(COLUMNS).filter((name) => !existing.has(name));
  if (!missing.length) return [];
  await prisma.$executeRawUnsafe(
    `ALTER TABLE \`messages\` ${missing.map((name) => COLUMNS[name]).join(", ")}`,
  );
  console.log(`[messages] added column(s): ${missing.join(", ")}`);
  return missing;
};

module.exports = {
  COLUMNS,
  ensureMessageColumns,
  // Older name, kept for callers that still use it.
  ensureMessageEditColumns: ensureMessageColumns,
};
