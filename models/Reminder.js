const { Schema, model } = require("mongoose");

const reminderSchema = new Schema(
  {
    user: { type: Schema.Types.ObjectId, ref: "Profile", required: true, index: true },
    title: { type: String, required: true, trim: true, maxlength: 120 },
    type: { type: String, enum: ["meal", "water", "workout", "weight", "custom"], default: "custom" },
    time: { type: String, required: true, match: /^([01]\d|2[0-3]):[0-5]\d$/ },
    days: {
      type: [Number],
      default: [0, 1, 2, 3, 4, 5, 6],
      validate: { validator: (days) => days.every((day) => Number.isInteger(day) && day >= 0 && day <= 6), message: "days must contain weekdays from 0 to 6" },
    },
    enabled: { type: Boolean, default: true },
    message: { type: String, trim: true, maxlength: 300 },
    notificationId: { type: String, trim: true },
    lastNotifiedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

module.exports = model("Reminder", reminderSchema);
