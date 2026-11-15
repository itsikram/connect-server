const express = require('express');
const router = express.Router();
const isAuth = require('../middlewares/isAuth');

// Tokens last at most a day; clients ask again for each call.
const MAX_TOKEN_SECONDS = 24 * 3600;
const MIN_TOKEN_SECONDS = 60;

// Lazy require to avoid crashing if not installed yet; throw clear error when route is hit
let RtcTokenBuilder, RtcRole;
try {
  ({ RtcTokenBuilder, RtcRole } = require('agora-access-token'));
} catch (e) {
  // noop, we will validate below
}

// Only signed-in users can get a call token.
router.post('/token', isAuth, async (req, res) => {
  try {
    if (!RtcTokenBuilder || !RtcRole) {
      return res.status(500).json({ error: 'agora-access-token package not installed on server' });
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      return res.status(500).json({ error: 'Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE in environment' });
    }

    const { channelName, uid, role = 'publisher', expireInSec = 24 * 3600 } = req.body || {};

    if (!channelName || typeof channelName !== 'string' || channelName.length > 64) {
      return res.status(400).json({ error: 'channelName is required (at most 64 characters)' });
    }

    const rtcRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    const currentTs = Math.floor(Date.now() / 1000);
    const requestedSeconds = Number(expireInSec) || MAX_TOKEN_SECONDS;
    const lifetime = Math.min(MAX_TOKEN_SECONDS, Math.max(MIN_TOKEN_SECONDS, requestedSeconds));
    const privilegeExpireTs = currentTs + lifetime;

    let token;
    if (typeof uid === 'string' && uid.trim().length > 0) {
      token = RtcTokenBuilder.buildTokenWithAccount(
        appId,
        appCertificate,
        channelName,
        uid,
        rtcRole,
        privilegeExpireTs
      );
    } else {
      const numericUid = typeof uid === 'number' ? uid : 0;
      token = RtcTokenBuilder.buildTokenWithUid(
        appId,
        appCertificate,
        channelName,
        numericUid,
        rtcRole,
        privilegeExpireTs
      );
    }

    return res.json({ appId, token, channelName, uid: uid ?? 0, expireAt: privilegeExpireTs });
  } catch (err) {
    console.error('Agora token error:', err);
    return res.status(500).json({ error: 'Failed to generate token' });
  }
});

module.exports = router;