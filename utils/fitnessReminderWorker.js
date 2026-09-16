const Reminder = require("../models/Reminder");
const { sendPushToProfile } = require("./pushNotifications");

const INTERVAL_MS = 60 * 1000;
let workerInterval = null;
let isRunning = false;

function getLocalParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone || "Asia/Dhaka",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(
    parts.filter(({ type }) => type !== "literal").map(({ type, value }) => [type, value]),
  );
}

const weekdayNumber = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

async function runFitnessReminderTick() {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    const reminders = await Reminder.find({ enabled: true })
      .select("_id user title message time days timezone lastNotifiedAt")
      .lean();

    for (const reminder of reminders) {
      let local;
      try {
        local = getLocalParts(now, reminder.timezone);
      } catch (error) {
        console.warn("[fitness-reminder] invalid timezone", reminder.timezone, error?.message || error);
        continue;
      }
      const day = weekdayNumber[local.weekday];
      const time = `${local.hour}:${local.minute}`;
      if (reminder.time !== time || !(reminder.days || [0, 1, 2, 3, 4, 5, 6]).includes(day)) continue;
      // Use the user's local date/time as the idempotency slot. This avoids
      // duplicate sends while allowing reminders in different timezones.
      const slot = new Date(`${local.year}-${local.month}-${local.day}T${time}:00.000Z`);
      if (reminder.lastNotifiedAt && reminder.lastNotifiedAt >= slot) continue;
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
