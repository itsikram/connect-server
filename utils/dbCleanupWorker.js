// Replaces the MongoDB TTL indexes that used to expire documents:
// - RecoveryChatMessage: 180 days after createdAt
// - YtDownloadProgress: 2 hours after the last update
const { prisma } = require("../config/prisma");

const RECOVERY_CHAT_RETENTION_MS = 180 * 24 * 60 * 60 * 1000;
const YT_PROGRESS_RETENTION_MS = 2 * 60 * 60 * 1000;
const INTERVAL_MS = 10 * 60 * 1000;

let timer = null;

async function runDbCleanup() {
  const now = Date.now();
  try {
    await prisma.recoveryChatMessage.deleteMany({
      where: { createdAt: { lt: new Date(now - RECOVERY_CHAT_RETENTION_MS) } },
    });
    await prisma.ytDownloadProgress.deleteMany({
      where: { updatedAt: { lt: new Date(now - YT_PROGRESS_RETENTION_MS) } },
    });
  } catch (e) {
    console.error("[dbCleanup] failed:", e.message || e);
  }
}

function startDbCleanupWorker() {
  if (timer) return;
  runDbCleanup();
  timer = setInterval(runDbCleanup, INTERVAL_MS);
  timer.unref?.();
}

module.exports = { startDbCleanupWorker, runDbCleanup };
