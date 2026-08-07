const Setting = require('../models/Setting')

const defaultSettings = () => ({
    isShareEmotion: false,
    isShareLocation: true,
    showIsTyping: true,
    ringtone: 1,
    themeMode: 'dark',
    postVisibility: 'public',
    friendRequestVisibility: 'public',
    timelinePostVisibility: 'public',
    friendRequestReceived: true,
    friendRequestAccepted: true,
    newMessageReceived: true,
    newFriendPost: true,
    newFriendStory: true,
    newFriendWatch: true,
    friendRequestReceivedEmail: false,
    friendRequestAcceptedEmail: false,
    newMessageReceivedEmail: false,
    newFriendPostEmail: false,
    newFriendStoryEmail: false,
    newFriendWatchEmail: false,
})

exports.getSetting = async (req, res, next) => {
    try {
        const profileId = req.query.profileId
        if (!profileId) {
            return res.status(400).json({ message: 'profileId is required' })
        }

        const settings = await Setting.findOne({ profile: profileId })
        if (settings) {
            return res.status(200).json(settings)
        }

        return res.status(200).json(defaultSettings())
    } catch (error) {
        next(error)
    }
}

exports.addSetting = async (req, res, next) => {
    try {
        const profileId = req.profile._id
        const existing = await Setting.findOne({ profile: profileId })
        if (existing) {
            return res.status(200).json(existing)
        }

        const saved = await new Setting({
            profile: profileId,
            ...defaultSettings(),
            ...req.body,
        }).save()

        return res.status(200).json(saved)
    } catch (error) {
        next(error)
    }
}

exports.updateSetting = async (req, res, next) => {
    try {
        const settingObject = { ...req.body }
        const profileId = req.profile._id
        delete settingObject.profile

        if (settingObject.ringtone !== undefined) {
            settingObject.ringtone = Number(settingObject.ringtone) || 1
        }

        const existing = await Setting.findOne({ profile: profileId })
        if (!existing) {
            const saved = await new Setting({
                profile: profileId,
                ...defaultSettings(),
                ...settingObject,
            }).save()
            return res.status(200).json(saved)
        }

        const updatedSetting = await Setting.findOneAndUpdate(
            { profile: profileId },
            { $set: settingObject },
            { new: true }
        )

        if (updatedSetting) {
            return res.status(200).json(updatedSetting)
        }

        return res.status(404).json({ message: 'Settings not found' })
    } catch (error) {
        next(error)
    }
}
