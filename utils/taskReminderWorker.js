const { prisma } = require("./db");

const CHECKPOINT_KEYS = new Set(["before30", "before15", "atTime"]);

// Atomically flips notificationSent.<key> to true; true when this call claimed it.
async function claimCheckpoint(task, key) {
  if (!CHECKPOINT_KEYS.has(key)) return false;
  const path = `$.${key}`;
  const count = await prisma.$executeRawUnsafe(
    "UPDATE `tasks` SET `notificationSent` = JSON_SET(COALESCE(`notificationSent`, JSON_OBJECT()), ?, true), `updatedAt` = NOW(3) " +
      "WHERE `id` = ? AND `completed` = 0 AND `taskTime` = ? " +
      "AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(`notificationSent`, ?)), 'false') <> 'true'",
    path,
    task.id,
    task.taskTime,
    path,
  );
  return count > 0;
}
const { sendPushToProfile } = require("./pushNotifications");
const { sendWebPushToProfile } = require("./webPush");

const INTERVAL_MS = 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
// Daily reminders due in minutes a slow tick, timer drift or a restart
// skipped (up to this long ago) are still sent; the lastReminderDate claim
// stops a second send for the same day.
const CATCH_UP_MS = 10 * 60 * 1000;
let workerInterval = null;
let isRunning = false;
let lastTickAt = 0;

function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]));
}

async function runTaskReminderTick(now = new Date()) {
  if (isRunning) return;
  isRunning = true;
  try {
    const windowMs = Math.min(CATCH_UP_MS, Math.max(INTERVAL_MS, now.getTime() - lastTickAt));
    const minuteStart = now.getTime() - (now.getTime() % 60000);
    const candidates = await prisma.task.findMany({
      where: {
        completed: false,
        OR: [
          { taskTime: { not: null } },
          { reminderTime: { not: null }, reminderTimezone: { not: null } },
        ],
      },
      select: {
        id: true,
        user: true,
        text: true,
        taskTime: true,
        notificationSent: true,
        reminderTime: true,
        reminderTimezone: true,
        lastReminderDate: true,
        updatedAt: true,
      },
    });

    for (const task of candidates) {
      if (task.taskTime) {
        const taskTime = new Date(task.taskTime).getTime();
        const elapsedMs = now.getTime() - taskTime;
        const checkpoints = [
          { key: "before30", offsetMs: 30 * 60 * 1000, title: "Task in 30 minutes", body: `Coming up in 30 minutes: ${task.text}` },
          { key: "before15", offsetMs: 15 * 60 * 1000, title: "Task in 15 minutes", body: `Coming up in 15 minutes: ${task.text}` },
          { key: "atTime", offsetMs: 0, title: "Task time", body: `It's time: ${task.text}` },
        ];
        for (const checkpoint of checkpoints) {
          const isDue = checkpoint.key === "before30"
            ? elapsedMs >= -30 * 60 * 1000 && elapsedMs < -15 * 60 * 1000
            : checkpoint.key === "before15"
              ? elapsedMs >= -15 * 60 * 1000 && elapsedMs < 0
              : elapsedMs >= 0;
          if (!isDue || task.notificationSent?.[checkpoint.key]) continue;
          const claimed = await claimCheckpoint(task, checkpoint.key);
          if (!claimed) continue;
          const payload = {
            title: checkpoint.title,
            body: checkpoint.body,
            data: { type: "task_reminder", taskId: String(task.id), checkpoint: checkpoint.key },
            link: "/tasks",
            tag: `task-reminder-${task.id}-${checkpoint.key}`,
          };
          await Promise.all([sendPushToProfile(task.user, payload), sendWebPushToProfile(task.user, payload)]);
        }
        continue;
      }
      let local;
      try {
        local = getLocalParts(now, task.reminderTimezone);
      } catch (error) {
        console.warn("[task-reminder] invalid timezone", task.reminderTimezone, error?.message || error);
        continue;
      }
      const [hour, minute] = String(task.reminderTime).split(":").map(Number);
      if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;
      // Local wall-clock times as UTC timestamps; the slot is the latest
      // reminder time at or before now (yesterday's when today's is ahead).
      const nowWall = Date.UTC(+local.year, +local.month - 1, +local.day, +local.hour, +local.minute);
      const todayWall = Date.UTC(+local.year, +local.month - 1, +local.day, hour, minute);
      const slotWall = todayWall <= nowWall ? todayWall : todayWall - DAY_MS;
      const lateMs = nowWall - slotWall;
      if (lateMs >= windowMs) continue;
      // Set or edited after a missed slot: wait for the next one.
      if (lateMs > 0 && task.updatedAt && new Date(task.updatedAt).getTime() >= minuteStart - lateMs + 60000) continue;
      const localDate = new Date(slotWall).toISOString().slice(0, 10);
      if (task.lastReminderDate === localDate) continue;

      const { count: claimed } = await prisma.task.updateMany({
        where: {
          id: task.id,
          completed: false,
          reminderTime: task.reminderTime,
          reminderTimezone: task.reminderTimezone,
          OR: [{ lastReminderDate: null }, { lastReminderDate: { not: localDate } }],
        },
        data: { lastReminderDate: localDate },
      });
      if (!claimed) continue;

      const payload = {
        title: "Task reminder",
        body: `Reminder: ${task.text}`,
        data: { type: "task_reminder", taskId: String(task.id) },
        link: "/tasks",
        tag: `task-reminder-${task.id}`,
      };
      await Promise.all([
        sendPushToProfile(task.user, payload),
        sendWebPushToProfile(task.user, payload),
      ]);
    }
    lastTickAt = now.getTime();
  } catch (error) {
    console.error("[task-reminder] worker tick failed:", error?.message || error);
  } finally {
    isRunning = false;
  }
}

function startTaskReminderWorker() {
  if (workerInterval) return workerInterval;
  workerInterval = setInterval(() => {
    runTaskReminderTick().catch((error) => {
      console.error("[task-reminder] unhandled worker error:", error?.message || error);
    });
  }, INTERVAL_MS);
  if (typeof workerInterval.unref === "function") workerInterval.unref();
  runTaskReminderTick().catch((error) => {
    console.error("[task-reminder] initial worker run failed:", error?.message || error);
  });
  return workerInterval;
}

module.exports = { startTaskReminderWorker, runTaskReminderTick };
