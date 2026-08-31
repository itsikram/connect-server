const Setting = require('../models/Setting');
const Profile = require('../models/Profile');

const RINGTONE_WEB_SRC = {
  1: '/assets/audio/default-ringtone.mp3',
  2: '/assets/audio/phone-ringtone-bells.mp3',
  3: '/assets/audio/old-telephone.mp3',
  4: '/assets/audio/phone-ringtone-telephone.mp3',
  5: '/assets/audio/phone-ringtone-office.mp3',
};

function normalizeRingtoneId(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 5) return 1;
  return parsed;
}

function getIncomingCallAlertConfig(ringtoneId) {
  const id = normalizeRingtoneId(ringtoneId);
  return {
    id,
    channelId: `incoming_calls_r${id}_v5`,
    soundName: `ringtone_${id}`,
    iosSound: `ringtone_${id}.mp3`,
    webSrc: RINGTONE_WEB_SRC[id],
  };
}

async function getIncomingCallAlertForProfile(profileId) {
  if (!profileId) return getIncomingCallAlertConfig(1);
  try {
    const profile = await Profile.findOne({
      $or: [{ _id: profileId }, { user: profileId }],
    }).select('_id');
    if (!profile) return getIncomingCallAlertConfig(1);

    const setting = await Setting.findOne({ profile: profile._id }).select('ringtone').lean();
    return getIncomingCallAlertConfig(setting?.ringtone);
  } catch (error) {
    console.warn('getIncomingCallAlertForProfile failed', error?.message || error);
    return getIncomingCallAlertConfig(1);
  }
}

module.exports = {
  normalizeRingtoneId,
  getIncomingCallAlertConfig,
  getIncomingCallAlertForProfile,
};
