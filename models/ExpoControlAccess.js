const { Schema, model } = require("mongoose");

// Access key for the Expo control daemon on the home PC (web /expo page).
// The owner pastes it once; the server checks it against the PC, then any
// browser signed in to an authorized account gets it without asking again.
const expoControlAccessSchema = new Schema(
  {
    singletonKey: {
      type: String,
      unique: true,
      default: "default",
    },
    accessKey: {
      type: String,
      default: "",
    },
    authorizedUsers: [
      {
        type: Schema.Types.ObjectId,
        ref: "User",
      },
    ],
  },
  { timestamps: true },
);

module.exports = model("ExpoControlAccess", expoControlAccessSchema);
