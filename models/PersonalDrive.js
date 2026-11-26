const mongoose = require('mongoose');
const { Schema } = mongoose;

const connectionSchema = new Schema({
    _id: String,
    googleSubject: { type: String, required: true },
    email: { type: String, required: true },
    refreshToken: { type: String, required: true, select: false },
    enabled: { type: Boolean, default: true },
}, { timestamps: true });

const consentSchema = new Schema({
    _id: String,
    owner: { type: String, required: true },
    verifier: { type: String, required: true },
    expiresAt: { type: Date, required: true, expires: 0 },
});

const fileSchema = new Schema({
    _id: String,
    owner: { type: String, required: true },
    recipient: { type: String, required: true },
    googleSubject: { type: String, required: true },
    driveId: { type: String, required: true },
    name: { type: String, required: true },
    mime: { type: String, required: true },
    kind: { type: String, required: true },
}, { timestamps: true });

module.exports = {
    DriveConnection: mongoose.model('PersonalDriveConnection', connectionSchema),
    DriveConsent: mongoose.model('PersonalDriveConsent', consentSchema),
    DriveFile: mongoose.model('PersonalDriveFile', fileSchema),
};
