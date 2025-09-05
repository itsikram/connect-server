const { mongoose } = require('mongoose')
const Notification = require('../models/Notification')
const Profile = require('../models/Profile')
const { sendPushToProfile } = require('../utils/pushNotifications')

exports.notificationSocket = async (io, socket) => {
    socket.on('fetchNotifications',async(profileId) => {
        let notificaitons = await Notification.find({ receiverId: profileId }).limit(25).sort({timestamp: -1})
        // console.log(notificaitons)
        io.to(profileId).emit('oldNotifications', notificaitons.reverse())
    })

    return () => {socket.off('fetchNotifications')}
}

exports.saveNotification = async (io, data) => {

    let receiverId = (data.receiverId).toString() || ''
    let notificationText = data.text || ''
    let notificationLink = data.link || '/';
    let notificationIcon = data.icon || null;
    let notificationType = data.type || null;
    let notification = new Notification({
        receiverId,
        text: notificationText,
        link: notificationLink,
        icon: notificationIcon,
        type: notificationType,

    })
    let newNotification = await notification.save()

    if (newNotification) {
        io.to(receiverId).emit('newNotification', newNotification)
        // return res.json({message: 'New Notification Created'}).json(200)
    }
    // return res.json({message: 'Notification Creation Failed'}).json(400)
}

exports.postNotification = async (req, res, next) => {
    let receiverId = req.body.receiverId
    let notificationText = req.body.text;
    let notificationLink = req.body.link || '/';
    let notificationIcon = req.body.icon || null;
    let notificationType = req.body.type || null;
    let notification = new Notification({
        receiverId,
        text: notificationText,
        link: notificationLink,
        icon: notificationIcon,
        type: notificationType,

    })

    let newNotification = await notification.save()
    if (newNotification) {
        return res.json({ message: 'New Notification Created' }).json(200)
    }
    return res.json({ message: 'Notification Creation Failed' }).json(400)

}

exports.notificationView = async (req, res, next) => {
    let notificationId = req.body.notificationId

    if (!mongoose.isValidObjectId(notificationId)) return next()

    let updatedNotification = await Notification.findOneAndUpdate({ _id: notificationId }, {
        isSeen: true
    }, { new: true })

    if (updatedNotification) {

        return res.json({ message: 'Notification status updated successfully' }).status(200)
    }
    res.json({ message: 'Something went wrong' }).status(400)
}
exports.notificationViewAll = async (req, res, next) => {
    let profile = req.profile


    let updatedNotification = await Notification.updateMany({ receiverId: profile._id  }, {
        isSeen: true
    }, { new: true })

    if (updatedNotification) {

        return res.json({ message: 'Notification status updated successfully' }).status(200)
    }
    res.json({ message: 'Something went wrong' }).status(400)
}

exports.getNotifications = async (req, res, next) => {
    let io = req.app.get('io')
    let receverId = req.query.receverId || req.profile._id;
    let notifications =  await Notification.find({ receiverId: receverId }).limit(25).sort({timestamp: -1})
    if (notifications) {
        return res.json(notifications).status(200)
    }
    return res.json({ message: 'Failed to get notificaiton' }).status(400)

}
exports.deleteAllNotifications = async (req, res, next) => {
let profileId = req.body.profile
    let deletedNotification = await Notification.deleteMany({ receiverId: profileId})
    if (deletedNotification) {
        return res.json({
            message: 'All Notifications Are deleted'
        }).status(200)
    }
    return res.json({ message: 'Failed to get notificaiton' }).status(400)

}

// Register a device token to the authenticated profile
exports.registerDeviceToken = async (req, res, next) => {
    try {
        const token = (req.body?.token || '').trim();
        if (!token) return res.status(400).json({ message: 'Token is required' });

        const profileId = req.profile._id;
        const updated = await Profile.findByIdAndUpdate(
            profileId,
            { $addToSet: { deviceTokens: token } },
            { new: true }
        ).select('deviceTokens');

        return res.status(200).json({ message: 'Token registered', deviceTokens: updated?.deviceTokens || [] });
    } catch (err) {
        next(err);
    }
}

// Unregister a device token from the authenticated profile
exports.unregisterDeviceToken = async (req, res, next) => {
    try {
        const token = (req.body?.token || '').trim();
        if (!token) return res.status(400).json({ message: 'Token is required' });

        const profileId = req.profile._id;
        const updated = await Profile.findByIdAndUpdate(
            profileId,
            { $pull: { deviceTokens: token } },
            { new: true }
        ).select('deviceTokens');

        return res.status(200).json({ message: 'Token unregistered', deviceTokens: updated?.deviceTokens || [] });
    } catch (err) {
        next(err);
    }
}

// Optional: send a test push to the authenticated user
exports.sendTestPush = async (req, res, next) => {
    try {
        const profileId = req.profile._id;
        const { title = 'Test Notification', body = 'This is a test', data = {} } = req.body || {};
        const result = await sendPushToProfile(profileId, {
            title,
            body,
            data,
        });
        return res.status(200).json({ message: 'Sent', result });
    } catch (err) {
        next(err);
    }
}