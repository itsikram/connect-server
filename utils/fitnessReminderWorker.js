const { prisma } = require("./db");
const { sendPushToProfile } = require("./pushNotifications");

const INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// A slow tick, timer drift or a restart can skip a minute; reminders due in
// the missed minutes (up to this long ago) are still sent. The lastNotifiedAt
// claim below stops a reminder going out twice for one slot.
const CATCH_UP_MS = 10 * 60 * 1000;
let workerInterval = null;
let isRunning = false;
let lastTickAt = 0;

function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]),
  );
}

async function runFitnessReminderTick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const windowMs = Math.min(CATCH_UP_MS, Math.max(INTERVAL_MS, now.getTime() - lastTickAt));
    const minuteStart = now.getTime() - (now.getTime() % 60000);
    const reminders = await prisma.reminder.findMany({
      where: { enabled: true },
      select: { id: true, user: true, title: true, message: true, time: true, days: true, timezone: true, lastNotifiedAt: true, updatedAt: true },
    });

    for (const reminder of reminders) {
      let local;
      try {
        local = getLocalParts(now, reminder.timezone);
      } catch (error) {
        console.warn("[fitness-reminder] invalid timezone", reminder.timezone, error?.message || error);
        continue;
      }
      const [hour, minute] = String(reminder.time || "").split(":").map(Number);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;
      // Local wall-clock times as UTC timestamps; the slot is the latest
      // reminder time at or before now (yesterday's when today's is ahead).
      // It doubles as the idempotency key across timezones.
      const nowWall = Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour, +local.minute);
      const todayWall = Date.UTC(+local.year, +local.month - 1, +local.day, hour, minute);
      const slotWall = todayWall <= nowWall ? todayWall : todayWall - DAY_MS;
      const lateMs = nowWall - slotWall;
      if (lateMs >= windowMs) continue;
      const slot = new Date(slotWall);
      if (!(Array.isArray(reminder.days) ? reminder.days : [0, 1, 2, 3, 4, 5, 6]).includes(slot.getUTCDay())) continue;
      // Created, switched on or edited after a missed slot: wait for the next one.
      if (lateMs > 0 && reminder.updatedAt && reminder.updatedAt.getTime() >= minuteStart - lateMs + 60000) continue;
      if (reminder.lastNotifiedAt && reminder.lastNotifiedAt >= slot) continue;
      const { count: claimed } = await prisma.reminder.updateMany({
        where: {
          id: reminder.id,
          OR: [{ lastNotifiedAt: null }, { lastNotifiedAt: { lt: slot } }],
        },
        data: { lastNotifiedAt: slot },
      });
      if (!claimed) continue;

      await sendPushToProfile(reminder.user, {
        title: reminder.title || "Fitness reminder",
        body: reminder.message || `Time to log ${reminder.title || "your fitness activity"}.`,
        data: { type: "fitness_reminder", reminderId: String(reminder.id) },
      });
    }
    lastTickAt = now.getTime();
  } catch (error) {
    console.error("[fitness-reminder] worker tick failed:", error?.message || error);
  } finally {
    isRunning = false;
  }
}

function startFitnessReminderWorker() {
  if (workerInterval) return workerInterval;
  workerInterval = setInterval(() => {
    runFitnessReminderTick().catch((error) => {
      console.error("[fitness-reminder] unhandled worker error:", error?.message || error);
    });
  }, INTERVAL_MS);
  if (typeof workerInterval.unref === "function") workerInterval.unref();
  runFitnessReminderTick().catch((error) => {
    console.error("[fitness-reminder] initial worker run failed:", error?.message || error);
  });
  return workerInterval;
}

module.exports = { startFitnessReminderWorker, runFitnessReminderTick };
