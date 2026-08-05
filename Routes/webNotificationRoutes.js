const express = require('express');
const router = express.Router();
const { 
    registerBrowserId, 
    unregisterBrowserId, 
    getBrowserIds,
    sendNotificationToBrowsers,
    sendNotificationToAllBrowsers,
    updateBrowserActivity,
    sendTestNotification,
    unregisterAllBrowsers,
    getVapidPublicKeyHandler,
    subscribeWebPush,
    unsubscribeWebPush,
} = require('../controllers/webNotificationController');
const isAuth = require('../middlewares/isAuth');

// VAPID public key (needed before PushManager.subscribe)
router.get('/vapid-public-key', getVapidPublicKeyHandler);

// Web Push subscription (iOS Home Screen / PWA background notifications)
router.post('/subscribe', isAuth, subscribeWebPush);
router.post('/unsubscribe', isAuth, unsubscribeWebPush);

// Register browser ID for notifications
router.post('/register-browser', isAuth, registerBrowserId);

// Unregister browser ID
router.post('/unregister-browser', isAuth, unregisterBrowserId);
router.post('/unregister-all-browsers', isAuth, unregisterAllBrowsers);

// Get browser IDs for a profile
router.get('/browser-ids/:profileId', isAuth, getBrowserIds);

// Send notification to specific browser IDs
router.post('/send-to-browsers', isAuth, sendNotificationToBrowsers);

// Send notification to all browsers of a profile
router.post('/send-to-all-browsers', isAuth, sendNotificationToAllBrowsers);

// Update browser activity (keep-alive)
router.post('/update-activity', isAuth, updateBrowserActivity);

// Send test notification
router.post('/test', isAuth, sendTestNotification);

module.exports = router;
