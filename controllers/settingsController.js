const Setting = require('../models/Setting')
const { v2: cloudinary } = require('cloudinary')
const streamifier = require('streamifier')

cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '', 
    api_key: process.env.CLOUDINARY_API_KEY || '', 
    api_secret: process.env.CLOUDINARY_API_SECRET 
})

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

        // Handle chatBackground file upload if present
        if (req.file) {
            try {
                const uploadResult = await new Promise((resolve, reject) => {
                    const uploadStream = cloudinary.uploader.upload_stream(
                        {
                            resource_type: 'auto',
                            folder: 'chat-backgrounds',
                        },
                        (error, result) => {
                            if (error) reject(error)
                            else resolve(result)
                        }
                    )
                    streamifier.createReadStream(req.file.buffer).pipe(uploadStream)
                })
                settingObject.chatBackground = uploadResult.secure_url
            } catch (uploadError) {
                console.error('Cloudinary upload error:', uploadError)
                return res.status(500).json({ message: 'Failed to upload chat background' })
            }
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
