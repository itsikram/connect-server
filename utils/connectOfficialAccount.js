const bcrypt = require("bcrypt");
const User = require("../models/User");
const Profile = require("../models/Profile");
const config = require("../config/config.json");

const OFFICIAL_EMAIL =
  process.env.CONNECT_OFFICIAL_EMAIL || "connect.official@app.local";
const OFFICIAL_USERNAME = process.env.CONNECT_OFFICIAL_USERNAME || "connect";

let cachedOfficial = null;

const ensureOfficialAccount = async () => {
  if (cachedOfficial?._id) return cachedOfficial;

  let profile = await Profile.findOne({ isOfficial: true });
  if (profile) {
    cachedOfficial = profile;
    return profile;
  }

  let user = await User.findOne({ email: OFFICIAL_EMAIL.toLowerCase() });
  if (!user) {
    const password = await bcrypt.hash(
      process.env.CONNECT_OFFICIAL_PASSWORD || `connect-official-${Date.now()}`,
      10,
    );
    user = await User.create({
      firstName: "Connect",
      surname: "Official",
      email: OFFICIAL_EMAIL.toLowerCase(),
      password,
      gender: "other",
      username: OFFICIAL_USERNAME,
    });
  }

  profile = await Profile.findOne({ user: user._id });
  const usernameTaken = await Profile.findOne({
    username: OFFICIAL_USERNAME,
    user: { $ne: user._id },
  });
  const username = usernameTaken ? "connectofficial" : OFFICIAL_USERNAME;

  if (!profile) {
    profile = await Profile.create({
      user: user._id,
      username,
      nickname: "Connect",
      fullName: "Connect",
      displayName: "Connect",
      bio: "Official Connect account. Daily prompts and icebreakers — we are not a person.",
      profilePic: config?.logo || config?.defaultProfile,
      coverPic: config?.defaultCover,
      isOfficial: true,
    });
    user.profile = profile._id;
    await user.save();
  } else {
    profile.isOfficial = true;
    profile.fullName = profile.fullName || "Connect";
    profile.username = profile.username || username;
    profile.bio =
      profile.bio ||
      "Official Connect account. Daily prompts and icebreakers — we are not a person.";
    await profile.save();
    if (!user.profile) {
      user.profile = profile._id;
      await user.save();
    }
  }

  cachedOfficial = profile;
  return profile;
};

module.exports = {
  ensureOfficialAccount,
  OFFICIAL_EMAIL,
  OFFICIAL_USERNAME,
};
