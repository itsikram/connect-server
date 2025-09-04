const express = require('express');
const router = express.Router();

// Lazy require to avoid crashing if not installed yet; throw clear error when route is hit
let RtcTokenBuilder, RtcRole;
try {
  ({ RtcTokenBuilder, RtcRole } = require('agora-access-token'));
} catch (e) {
  // noop, we will validate below
}

router.post('/token', async (req, res) => {
  try {
    if (!RtcTokenBuilder || !RtcRole) {
      return res.status(500).json({ error: 'agora-access-token package not installed on server' });
    }

    const appId = process.env.AGORA_APP_ID;
    const appCertificate = process.env.AGORA_APP_CERTIFICATE;
    if (!appId || !appCertificate) {
      return res.status(500).json({ error: 'Missing AGORA_APP_ID or AGORA_APP_CERTIFICATE in environment' });
    }

    const { channelName, uid, role = 'publisher', expireInSec = 3600 } = req.body || {};

    console.log('req.body', req.body)

    if (!channelName) return res.status(400).json({ error: 'channelName is required' });

    const rtcRole = role === 'subscriber' ? RtcRole.SUBSCRIBER : RtcRole.PUBLISHER;
    const currentTs = Math.floor(Date.now() / 1000);
    const privilegeExpireTs = currentTs + Number(expireInSec || 3600);

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