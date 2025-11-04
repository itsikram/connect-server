const { mongoose } = require('mongoose');
const Profile = require('../models/Profile');
const Notification = require('../models/Notification');
const config = require('../config/config.json');

// Register browser ID for a profile
exports.registerBrowserId = async (req, res, next) => {
    try {
        const { profileId, browserId, userAgent } = req.body;

        if (!profileId || !browserId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID and Browser ID are required'
            });
        }

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Check if browser ID already exists
        const existingBrowserIndex = profile.browserIds.findIndex(
            browser => browser.browserId === browserId
        );

        if (existingBrowserIndex !== -1) {
            // Update existing browser ID
            profile.browserIds[existingBrowserIndex].lastActive = new Date();
            profile.browserIds[existingBrowserIndex].isActive = true;
            profile.browserIds[existingBrowserIndex].userAgent = userAgent;
        } else {
            // Add new browser ID
            profile.browserIds.push({
                browserId,
                userAgent,
                lastActive: new Date(),
                isActive: true
            });
        }

        // Use save with validateBeforeSave option to skip validation
        await profile.save({ validateBeforeSave: false });

        res.json({
            success: true,
            message: 'Browser ID registered successfully',
            data: {
                profileId,
                browserId,
                totalBrowsers: profile.browserIds.length
            }
        });

    } catch (error) {
        console.error('Error registering browser ID:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Unregister browser ID from a profile
exports.unregisterBrowserId = async (req, res, next) => {
    try {
        const { profileId, browserId } = req.body;

        if (!profileId || !browserId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID and Browser ID are required'
            });
        }

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Remove browser ID
        profile.browserIds = profile.browserIds.filter(
            browser => browser.browserId !== browserId
        );

        // Use save with validateBeforeSave option to skip validation
        await profile.save({ validateBeforeSave: false });

        res.json({
            success: true,
            message: 'Browser ID unregistered successfully',
            data: {
                profileId,
                browserId,
                remainingBrowsers: profile.browserIds.length
            }
        });

    } catch (error) {
        console.error('Error unregistering browser ID:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Unregister all browser IDs for the authenticated profile
exports.unregisterAllBrowsers = async (req, res, next) => {
    try {
        const profileId = req?.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                success: false,
                message: 'Unauthorized'
            });
        }

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Clear all registered browsers/devices
        profile.browserIds = [];

        // Use save with validateBeforeSave option to skip validation
        await profile.save({ validateBeforeSave: false });

        res.json({
            success: true,
            message: 'All browsers unregistered successfully',
            data: {
                profileId,
                remainingBrowsers: profile.browserIds.length
            }
        });

    } catch (error) {
        console.error('Error unregistering all browsers:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
// Unregister browser ID from a profile
exports.unregisterBrowserId = async (req, res, next) => {
    try {
        const { profileId, browserId } = req.body;

        if (!profileId || !browserId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID and Browser ID are required'
            });
        }

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Remove browser ID
        profile.browserIds = profile.browserIds.filter(
            browser => browser.browserId !== browserId
        );

        // Use save with validateBeforeSave option to skip validation
        await profile.save({ validateBeforeSave: false });

        res.json({
            success: true,
            message: 'Browser ID unregistered successfully',
            data: {
                profileId,
                browserId,
                remainingBrowsers: profile.browserIds.length
            }
        });

    } catch (error) {
        console.error('Error unregistering browser ID:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Get browser IDs for a profile
exports.getBrowserIds = async (req, res, next) => {
    try {
        const { profileId } = req.params;

        if (!profileId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID is required'
            });
        }

        const profile = await Profile.findById(profileId).select('browserIds');
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        res.json({
            success: true,
            data: {
                profileId,
                browserIds: profile.browserIds
            }
        });

    } catch (error) {
        console.error('Error getting browser IDs:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Send notification to specific browser IDs
exports.sendNotificationToBrowsers = async (req, res, next) => {
    try {
        const { profileId, browserIds, notificationData } = req.body;

        if (!profileId || !browserIds || !Array.isArray(browserIds)) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID and browser IDs array are required'
            });
        }

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Filter valid browser IDs
        const validBrowserIds = profile.browserIds
            .filter(browser => 
                browserIds.includes(browser.browserId) && 
                browser.isActive
            )
            .map(browser => browser.browserId);

        if (validBrowserIds.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No valid active browser IDs found'
            });
        }

        // Create notification in database
        const notification = new Notification({
            receiverId: profileId,
            text: notificationData.text || 'New notification',
            title: notificationData.title || 'Connect',
            icon: notificationData.icon || config?.logo,
            link: notificationData.link || '/',
            type: notificationData.type || 'general',
            data: {
                ...notificationData.data,
                browserIds: validBrowserIds
            }
        });

        await notification.save();

        // Emit to socket for real-time delivery
        const io = req.app.get('io');
        if (io) {
            io.to(profileId).emit('newNotification', notification);
        }

        res.json({
            success: true,
            message: 'Notification sent successfully',
            data: {
                notificationId: notification._id,
                sentToBrowsers: validBrowserIds.length,
                totalRequested: browserIds.length
            }
        });

    } catch (error) {
        console.error('Error sending notification to browsers:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Send notification to all browsers of a profile
exports.sendNotificationToAllBrowsers = async (req, res, next) => {
    try {
        const { profileId, notificationData } = req.body;

        if (!profileId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID is required'
            });
        }

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Get all active browser IDs
        const activeBrowserIds = profile.browserIds
            .filter(browser => browser.isActive)
            .map(browser => browser.browserId);

        if (activeBrowserIds.length === 0) {
            return res.status(404).json({
                success: false,
                message: 'No active browser IDs found for this profile'
            });
        }

        // Create notification in database
        const notification = new Notification({
            receiverId: profileId,
            text: notificationData.text || 'New notification',
            title: notificationData.title || 'Connect',
            icon: notificationData.icon || config?.logo,
            link: notificationData.link || '/',
            type: notificationData.type || 'general',
            data: {
                ...notificationData.data,
                browserIds: activeBrowserIds
            }
        });

        await notification.save();

        // Emit to socket for real-time delivery
        const io = req.app.get('io');
        if (io) {
            io.to(profileId).emit('newNotification', notification);
        }

        res.json({
            success: true,
            message: 'Notification sent to all browsers successfully',
            data: {
                notificationId: notification._id,
                sentToBrowsers: activeBrowserIds.length,
                browserIds: activeBrowserIds
            }
        });

    } catch (error) {
        console.error('Error sending notification to all browsers:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Update browser activity
exports.updateBrowserActivity = async (req, res, next) => {
    try {
        const { profileId, browserId } = req.body;

        if (!profileId || !browserId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID and Browser ID are required'
            });
        }

        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        // Update browser activity
        const browserIndex = profile.browserIds.findIndex(
            browser => browser.browserId === browserId
        );

        if (browserIndex !== -1) {
            profile.browserIds[browserIndex].lastActive = new Date();
            profile.browserIds[browserIndex].isActive = true;
            // Use save with validateBeforeSave option to skip validation
            await profile.save({ validateBeforeSave: false });
        }

        res.json({
            success: true,
            message: 'Browser activity updated successfully'
        });

    } catch (error) {
        console.error('Error updating browser activity:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};

// Example endpoint to send notification to specific browser IDs
exports.sendTestNotification = async (req, res, next) => {
    try {
        const { profileId, browserIds, message } = req.body;

        if (!profileId) {
            return res.status(400).json({
                success: false,
                message: 'Profile ID is required'
            });
        }

        const notificationData = {
            title: 'Test Notification',
            text: message || 'This is a test notification from the server',
            icon: config?.logo,
            link: '/',
            type: 'test',
            requireInteraction: true
        };

        // Find the profile
        const profile = await Profile.findById(profileId);
        if (!profile) {
            return res.status(404).json({
                success: false,
                message: 'Profile not found'
            });
        }

        let result;
        if (browserIds && Array.isArray(browserIds) && browserIds.length > 0) {
            // Send to specific browser IDs
            const validBrowserIds = profile.browserIds
                .filter(browser => 
                    browserIds.includes(browser.browserId) && 
                    browser.isActive
                )
                .map(browser => browser.browserId);

            if (validBrowserIds.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No valid active browser IDs found'
                });
            }

            // Create notification in database
            const notification = new Notification({
                receiverId: profileId,
                text: notificationData.text,
                title: notificationData.title,
                icon: notificationData.icon,
                link: notificationData.link,
                type: notificationData.type,
                data: {
                    ...notificationData.data,
                    browserIds: validBrowserIds
                }
            });

            await notification.save();

            // Emit to socket for real-time delivery
            const io = req.app.get('io');
            if (io) {
                io.to(profileId).emit('newNotification', notification);
            }

            result = {
                notificationId: notification._id,
                sentToBrowsers: validBrowserIds.length,
                totalRequested: browserIds.length
            };
        } else {
            // Send to all browsers
            const activeBrowserIds = profile.browserIds
                .filter(browser => browser.isActive)
                .map(browser => browser.browserId);

            if (activeBrowserIds.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: 'No active browser IDs found for this profile'
                });
            }

            // Create notification in database
            const notification = new Notification({
                receiverId: profileId,
                text: notificationData.text,
                title: notificationData.title,
                icon: notificationData.icon,
                link: notificationData.link,
                type: notificationData.type,
                data: {
                    ...notificationData.data,
                    browserIds: activeBrowserIds
                }
            });

            await notification.save();

            // Emit to socket for real-time delivery
            const io = req.app.get('io');
            if (io) {
                io.to(profileId).emit('newNotification', notification);
            }

            result = {
                notificationId: notification._id,
                sentToBrowsers: activeBrowserIds.length,
                browserIds: activeBrowserIds
            };
        }

        res.json({
            success: true,
            message: 'Test notification sent successfully',
            data: result
        });

    } catch (error) {
        console.error('Error sending test notification:', error);
        res.status(500).json({
            success: false,
            message: 'Internal server error',
            error: error.message
        });
    }
};
