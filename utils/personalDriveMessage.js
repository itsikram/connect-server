const { FILE_REF } = require('../services/personalDrive');

module.exports = async (attachment, sender, receiver) => {
    if (typeof attachment !== 'string' || !attachment.startsWith('drive-chat:')) return true;
    const ref = FILE_REF.exec(attachment);
    if (!ref) return false;
    const { DriveFile } = require('../models/PersonalDrive');
    return Boolean(await DriveFile.exists({
        _id: ref[1], owner: String(sender), recipient: String(receiver), kind: ref[2],
    }));
};
