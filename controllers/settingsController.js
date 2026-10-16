const { prisma, pickModelFields } = require('../utils/db')
const streamifier = require('streamifier')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')
const { withCloudinaryAccount } = require('../utils/cloudinary')

const defaultSettings = () => ({
    isShareEmotion: false,
    isShareLocation: true,
    showIsTyping: true,
    ringtone: 1,
    themeMode: 'dark',
    language: 'eng',
    postVisibility: 'public',
    connectRequestVisibility: 'public',
    timelinePostVisibility: 'public',
    connectRequestReceived: true,
    connectRequestAccepted: true,
    newMessageReceived: true,
    newConnectPost: true,
    newConnectStory: true,
    newConnectWatch: true,
    connectRequestReceivedEmail: false,
    connectRequestAcceptedEmail: false,
    newMessageReceivedEmail: false,
    newConnectPostEmail: false,
    newConnectStoryEmail: false,
    newConnectWatchEmail: false,
    connectChatSettings: {},
})

const findSetting = (profileId) =>
    prisma.setting.findFirst({ where: { profile: String(profileId) }, orderBy: { createdAt: 'asc' } })

const createSetting = (profileId, values) =>
    prisma.setting.create({
        data: { ...pickModelFields('Setting', { ...defaultSettings(), ...values }), profile: String(profileId) },
    })

exports.getSetting = async (req, res, next) => {
    try {
        const profileId = req.query.profileId
        if (!profileId) {
            return res.status(400).json({ message: 'profileId is required' })
        }

        const settings = await findSetting(profileId)
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
        const existing = await findSetting(profileId)
        if (existing) {
            return res.status(200).json(existing)
        }

        const saved = await createSetting(profileId, req.body)

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

        if (settingObject.language !== undefined) {
            const languageAliases = { en: 'eng', 'en-US': 'eng', 'bn-BD': 'bn' }
            settingObject.language = languageAliases[settingObject.language] || settingObject.language
            if (!['eng', 'bn'].includes(settingObject.language)) {
                return res.status(400).json({ message: 'Invalid language. Use eng or bn' })
            }
        }

        if (typeof settingObject.connectChatSettings === 'string') {
            try {
                settingObject.connectChatSettings = JSON.parse(settingObject.connectChatSettings)
            } catch (error) {
                delete settingObject.connectChatSettings
            }
        }

        // Handle chatBackground file upload if present
        if (req.file) {
            try {
                const uploadResult = await withCloudinaryAccount('image', (cloudinary) =>
                    new Promise((resolve, reject) => {
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
                    }),
                )
                settingObject.chatBackground = uploadResult.secure_url
            } catch (uploadError) {
                console.error('Cloudinary upload error:', uploadError)
                return res.status(500).json({ message: 'Failed to upload chat background' })
            }
        }

        const existing = await findSetting(profileId)
        if (!existing) {
            const saved = await createSetting(profileId, settingObject)
            return res.status(200).json(saved)
        }

        const updatedSetting = await prisma.setting.update({
            where: { id: existing.id },
            data: pickModelFields('Setting', settingObject),
        })

        if (updatedSetting) {
            if (req.file && existing?.chatBackground && existing.chatBackground !== updatedSetting.chatBackground) {
                await deleteCloudinaryResources([existing.chatBackground])
            }
            return res.status(200).json(updatedSetting)
        }

        return res.status(404).json({ message: 'Settings not found' })
    } catch (error) {
        next(error)
    }
}
