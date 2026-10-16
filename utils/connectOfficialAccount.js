const bcrypt = require("bcryptjs");
const { prisma } = require("./db");
const config = require("../config/config.json");

const OFFICIAL_EMAIL =
  process.env.CONNECT_OFFICIAL_EMAIL || "connect.official@app.local";
const OFFICIAL_USERNAME = process.env.CONNECT_OFFICIAL_USERNAME || "connect";

let cachedOfficial = null;

const ensureOfficialAccount = async () => {
  if (cachedOfficial?._id) return cachedOfficial;

  let profile = await prisma.profile.findFirst({ where: { isOfficial: true } });
  if (profile) {
    cachedOfficial = profile;
    return profile;
  }

  let user = await prisma.user.findFirst({ where: { email: OFFICIAL_EMAIL.toLowerCase() } });
  if (!user) {
    const password = await bcrypt.hash(
      process.env.CONNECT_OFFICIAL_PASSWORD || `connect-official-${Date.now()}`,
      10,
    );
    user = await prisma.user.create({
      data: {
        firstName: "Connect",
        surname: "Official",
        email: OFFICIAL_EMAIL.toLowerCase(),
        password,
        gender: "other",
        username: OFFICIAL_USERNAME,
      },
    });
  }

  profile = await prisma.profile.findFirst({ where: { user: user.id } });
  const usernameTaken = await prisma.profile.findFirst({
    where: { username: OFFICIAL_USERNAME, NOT: { user: user.id } },
    select: { id: true },
  });
  const username = usernameTaken ? "connectofficial" : OFFICIAL_USERNAME;

  if (!profile) {
    profile = await prisma.profile.create({
      data: {
        user: user.id,
        username,
        nickname: "Connect",
        fullName: "Connect",
        displayName: "Connect",
        bio: "Official Connect account. Daily prompts and icebreakers — we are not a person.",
        profilePic: config?.logo || config?.defaultProfile,
        coverPic: config?.defaultCover,
        isOfficial: true,
      },
    });
    await prisma.user.update({ where: { id: user.id }, data: { profile: profile.id } });
  } else {
    profile = await prisma.profile.update({
      where: { id: profile.id },
      data: {
        isOfficial: true,
        fullName: profile.fullName || "Connect",
        username: profile.username || username,
        bio:
          profile.bio ||
          "Official Connect account. Daily prompts and icebreakers — we are not a person.",
      },
    });
    if (!user.profile) {
      await prisma.user.update({ where: { id: user.id }, data: { profile: profile.id } });
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
