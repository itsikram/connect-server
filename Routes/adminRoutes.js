const Router = require("express").Router();
const {signUp,login,deleteAccount,getProfiles,getProfile,updateProfile,deleteProfile,getPosts,getPost,updatePost,deletePost,getWatches,getWatch,updateWatch,deleteWatch,getStories,deleteStory,setUserPassword,getStats,getReportedPosts,getReportedProfiles,updateReportStatus,forgotPassword,resetPassword,bulkDeletePosts,bulkUpdatePosts,bulkDeleteWatches,bulkUpdateWatches,bulkDeleteStories,bulkDeleteProfiles,bulkUpdateProfiles,bulkUpdateReportStatus} = require('../controllers/adminController')
const {uploadImage} = require('../controllers/uploadControllers')
const {listResources, deleteResources, migrateResources, migrateConfiguredResources, getMigrationStatus} = require('../controllers/cloudinaryController')
const isAdminAuth = require('../middlewares/isAdminAuth');
const isAdminRole = require('../middlewares/isAdminRole');
const canCreateAdmin = require('../middlewares/canCreateAdmin');
const {
  listPayments,
  approvePayment,
  rejectPayment,
} = require('../controllers/adminPaymentsController');
const multer = require('multer');
const {
  getMonetizationSettings,
  updateMonetizationSettings,
} = require('../controllers/monetizationSettingsController');
const {
  listSubscriptions,
  grantSubscription,
  revokeSubscription,
} = require('../controllers/adminSubscriptionController');
const { listPayouts, approvePayout, rejectPayout } = require("../controllers/adminPayoutController");

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

// Only a logged-in superAdmin can create admins (or anyone on an empty database)
Router.post('/signup', canCreateAdmin, signUp)
Router.post('/login',login)
Router.post('/forgot-password', forgotPassword)
Router.post('/reset-password/:token', resetPassword)
Router.post('/delete',deleteAccount)
// Bulk actions (admin token required)
// Same role as the single-profile edit/delete routes below
Router.post('/profiles/bulk-update', isAdminRole, bulkUpdateProfiles)
Router.post('/profiles/bulk-delete', isAdminRole, bulkDeleteProfiles)
Router.post('/posts/bulk-update', isAdminAuth, bulkUpdatePosts)
Router.post('/posts/bulk-delete', isAdminAuth, bulkDeletePosts)
Router.post('/watches/bulk-update', isAdminAuth, bulkUpdateWatches)
Router.post('/watches/bulk-delete', isAdminAuth, bulkDeleteWatches)
Router.post('/stories/bulk-delete', isAdminAuth, bulkDeleteStories)
Router.post('/reports/bulk-status', isAdminAuth, bulkUpdateReportStatus)
Router.get('/profiles', isAdminAuth, getProfiles)
Router.get('/profile/:id', isAdminAuth, getProfile)
Router.put('/profile/:id', isAdminRole, updateProfile)
// Admin set password for a user (by profile id) without current password
Router.post('/profile/:id/set-password', isAdminRole, setUserPassword)
Router.delete('/profile/:id', isAdminRole, deleteProfile)
Router.get('/posts', isAdminAuth, getPosts)
Router.get('/posts/:id', isAdminAuth, getPost)
Router.put('/posts/:id', isAdminAuth, updatePost)
Router.delete('/posts/:id', isAdminAuth, deletePost)
Router.get('/watches', isAdminAuth, getWatches)
Router.get('/watches/:id', isAdminAuth, getWatch)
Router.put('/watches/:id', isAdminAuth, updateWatch)
Router.delete('/watches/:id', isAdminAuth, deleteWatch)
Router.get('/stories', isAdminAuth, getStories)
Router.delete('/stories/:id', isAdminAuth, deleteStory)
Router.post('/upload', isAdminAuth, upload.single('image'), uploadImage)
// Admin summary stats and recent activities
Router.get('/stats', isAdminAuth, getStats)
Router.get('/cloudinary/resources', isAdminAuth, listResources)
Router.post('/cloudinary/resources/delete', isAdminAuth, deleteResources)
Router.post('/cloudinary/migrate', isAdminAuth, (req, res, next) => {
  if (!['superAdmin', 'admin'].includes(req.admin.role)) {
    return res.status(403).json({ message: 'Only administrators can migrate Cloudinary assets' });
  }
  return migrateResources(req, res, next);
})
Router.post('/cloudinary/migrate-configured', isAdminAuth, (req, res, next) => {
  if (!['superAdmin', 'admin'].includes(req.admin.role)) {
    return res.status(403).json({ message: 'Only administrators can migrate Cloudinary assets' });
  }
  return migrateConfiguredResources(req, res, next);
})
Router.get('/cloudinary/migrate/:jobId', isAdminAuth, getMigrationStatus)
// Reports
Router.get('/reports/posts', isAdminAuth, getReportedPosts)
Router.get('/reports/profiles', isAdminAuth, getReportedProfiles)
Router.put('/reports/:id/status', isAdminAuth, updateReportStatus)
Router.get('/payments', isAdminRole, listPayments)
Router.post('/payments/:id/approve', isAdminRole, approvePayment)
Router.post('/payments/:id/reject', isAdminRole, rejectPayment)
Router.get('/payouts', isAdminRole, listPayouts)
Router.post('/payouts/:id/approve', isAdminRole, approvePayout)
Router.post('/payouts/:id/reject', isAdminRole, rejectPayout)
Router.get('/monetization/settings', isAdminRole, getMonetizationSettings)
Router.put('/monetization/settings', isAdminRole, updateMonetizationSettings)
Router.get('/subscriptions', isAdminRole, listSubscriptions)
Router.post('/subscriptions/:id/grant', isAdminRole, grantSubscription)
Router.post('/subscriptions/:id/revoke', isAdminRole, revokeSubscription)

const {
  getAdminAiSettings,
  updateAdminAiSettings,
  listAdminCursorModels,
  testAdminAiProvider,
} = require('../controllers/aiSettingsController');
const aiAutoPostController = require('../controllers/aiAutoPostController');

Router.get('/ai-settings', isAdminAuth, getAdminAiSettings);
Router.put('/ai-settings', isAdminAuth, updateAdminAiSettings);
Router.get('/ai-settings/models', isAdminAuth, listAdminCursorModels);
Router.post('/ai-settings/test', isAdminAuth, testAdminAiProvider);

const {
  getAdminServerSettings,
  updateAdminServerSettings,
  checkAdminServers,
} = require('../controllers/serverSettingsController');
Router.get('/server-settings', isAdminAuth, getAdminServerSettings);
Router.put('/server-settings', isAdminAuth, updateAdminServerSettings);
Router.post('/server-settings/check', isAdminAuth, checkAdminServers);

const driveSettings = require('../controllers/driveSettingsController');
Router.get('/gdrive', isAdminAuth, driveSettings.getDriveSettings);
Router.put('/gdrive', isAdminAuth, driveSettings.updateDriveSettings);
Router.post('/gdrive/connect', isAdminAuth, driveSettings.startConnect);
// Google redirects the browser here, so no admin token; the signed state authenticates it
Router.get('/gdrive/callback', driveSettings.connectCallback);
Router.patch('/gdrive/accounts/:name', isAdminAuth, driveSettings.setAccountEnabled);
Router.delete('/gdrive/accounts/:name', isAdminAuth, driveSettings.removeAccount);

// Copy every Cloudinary file the database links to into Google Drive and relink it
const cloudinaryToDrive = require('../utils/cloudinaryToDrive');
Router.get('/gdrive/migrate-cloudinary', isAdminAuth, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ job: cloudinaryToDrive.getMigrationStatus() });
});
Router.post('/gdrive/migrate-cloudinary', isAdminAuth, async (req, res) => {
    try {
        const job = await cloudinaryToDrive.startMigration({ dryRun: req.body?.dryRun === true });
        res.status(202).json({ job });
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Could not start the migration' });
    }
});

// Latest APK, stored in Google Drive: the browser uploads straight to Drive,
// or the server copies it from a link
const apk = require('../controllers/apkController');
Router.post('/apk/upload-session', isAdminAuth, apk.startApkUpload);
Router.post('/apk/complete', isAdminAuth, apk.finishApkUpload);
Router.post('/apk/from-url', isAdminAuth, apk.copyApkFromUrl);
Router.get('/apk/status', isAdminAuth, apk.getApkJob);

Router.get('/ai-auto-post/config', isAdminRole, aiAutoPostController.getConfig);
Router.get('/ai-auto-post/author-profiles', isAdminRole, aiAutoPostController.searchAuthorProfiles);
Router.put('/ai-auto-post/config', isAdminRole, aiAutoPostController.updateConfig);
Router.post('/ai-auto-post/generate-now', isAdminRole, aiAutoPostController.generateNow);
Router.post('/ai-auto-post/generate', isAdminRole, aiAutoPostController.generateNow);
Router.get('/ai-auto-post/history', isAdminRole, aiAutoPostController.listHistory);
Router.post('/ai-auto-post/:id/publish', isAdminRole, aiAutoPostController.publish);
Router.post('/ai-auto-post/:id/regenerate', isAdminRole, aiAutoPostController.regenerate);
Router.put('/ai-auto-post/:id', isAdminRole, aiAutoPostController.updateGenerated);
Router.delete('/ai-auto-post/:id', isAdminRole, aiAutoPostController.deleteGenerated);
Router.post('/ai-auto-post/pause', isAdminRole, (req, res, next) => aiAutoPostController.setPaused({ ...req, body: { ...(req.body || {}), paused: true } }, res, next));
Router.post('/ai-auto-post/resume', isAdminRole, (req, res, next) => aiAutoPostController.setPaused({ ...req, body: { ...(req.body || {}), paused: false } }, res, next));

module.exports = Router;