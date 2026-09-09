const Reminder = require("../models/Reminder");
const { sendPushToProfile } = require("./pushNotifications");

const BD_OFFSET_MS = 6 * 60 * 60 * 1000;
const INTERVAL_MS = 60 * 1000;
let workerInterval = null;
let isRunning = false;

const getBangladeshNow = () => new Date(Date.now() + BD_OFFSET_MS);

async function runFitnessReminderTick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = getBangladeshNow();
    const day = now.getUTCDay();
    const hour = String(now.getUTCHours()).padStart(2, "0");
    const minute = String(now.getUTCMinutes()).padStart(2, "0");
    const time = `${hour}:${minute}`;
    const slot = new Date(Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      now.getUTCHours(),
      now.getUTCMinutes(),
    ) - BD_OFFSET_MS);

    const reminders = await Reminder.find({
      enabled: true,
      time,
      days: day,
      $or: [{ lastNotifiedAt: null }, { lastNotifiedAt: { $lt: slot } }],
    }).select("_id user title message time");

    for (const reminder of reminders) {
      const claimed = await Reminder.findOneAndUpdate(
        {
          _id: reminder._id,
          $or: [{ lastNotifiedAt: null }, { lastNotifiedAt: { $lt: slot } }],
        },
        { $set: { lastNotifiedAt: slot } },
        { new: true },
      );
      if (!claimed) continue;

      await sendPushToProfile(reminder.user, {
        title: reminder.title || "Fitness reminder",
        body: reminder.message || `Time to log ${reminder.title || "your fitness activity"}.`,
        data: { type: "fitness_reminder", reminderId: String(reminder._id) },
      });
    }
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
