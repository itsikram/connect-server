const Task = require("../models/Task");
const { sendPushToProfile } = require("./pushNotifications");
const { sendWebPushToProfile } = require("./webPush");

const INTERVAL_MS = 60 * 1000;
let workerInterval = null;
let isRunning = false;

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
    const candidates = await Task.find({
      completed: false,
      reminderTime: { $type: "string" },
      reminderTimezone: { $type: "string" },
    }).select("_id user text reminderTime reminderTimezone lastReminderDate");

    for (const task of candidates) {
      let local;
      try {
        local = getLocalParts(now, task.reminderTimezone);
      } catch (error) {
        console.warn("[task-reminder] invalid timezone", task.reminderTimezone, error?.message || error);
        continue;
      }
      const localDate = `${local.year}-${local.month}-${local.day}`;
      const localTime = `${local.hour}:${local.minute}`;
      if (task.reminderTime !== localTime || task.lastReminderDate === localDate) continue;

      const claimed = await Task.findOneAndUpdate(
        {
          _id: task._id,
          completed: false,
          reminderTime: task.reminderTime,
          reminderTimezone: task.reminderTimezone,
          lastReminderDate: { $ne: localDate },
        },
        { $set: { lastReminderDate: localDate } },
        { new: true },
      );
      if (!claimed) continue;

      const payload = {
        title: "Task reminder",
        body: `Reminder: ${task.text}`,
        data: { type: "task_reminder", taskId: String(task._id) },
        link: "/tasks",
        tag: `task-reminder-${task._id}`,
      };
      await Promise.all([
        sendPushToProfile(task.user, payload),
        sendWebPushToProfile(task.user, payload),
      ]);
    }
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
