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
      $or: [
        { taskTime: { $type: "date" } },
        { reminderTime: { $type: "string" }, reminderTimezone: { $type: "string" } },
      ],
    }).select("_id user text taskTime notificationSent reminderTime reminderTimezone lastReminderDate");

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
          const claimed = await Task.findOneAndUpdate(
            { _id: task._id, completed: false, taskTime: task.taskTime, [`notificationSent.${checkpoint.key}`]: { $ne: true } },
            { $set: { [`notificationSent.${checkpoint.key}`]: true } },
            { new: true },
          );
          if (!claimed) continue;
          const payload = {
            title: checkpoint.title,
            body: checkpoint.body,
            data: { type: "task_reminder", taskId: String(task._id), checkpoint: checkpoint.key },
            link: "/tasks",
            tag: `task-reminder-${task._id}-${checkpoint.key}`,
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
