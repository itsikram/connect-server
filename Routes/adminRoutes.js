const Router = require("express").Router();
const {signUp,login,deleteAccount,getProfiles,getProfile,updateProfile,deleteProfile,getPosts,getPost,updatePost,deletePost,getWatches,getWatch,updateWatch,deleteWatch,getStories,deleteStory,setUserPassword,getStats,getReportedPosts,getReportedProfiles,updateReportStatus,forgotPassword,resetPassword} = require('../controllers/adminController')
const {uploadImage} = require('../controllers/uploadControllers')
const {listResources, migrateResources, getMigrationStatus} = require('../controllers/cloudinaryController')
const isAdminAuth = require('../middlewares/isAdminAuth');
const isAdminRole = require('../middlewares/isAdminRole');
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

const upload = multer({ storage: multer.memoryStorage() });

Router.post('/signup',signUp)
Router.post('/login',login)
Router.post('/forgot-password', forgotPassword)
Router.post('/reset-password/:token', resetPassword)
Router.post('/delete',deleteAccount)
Router.get('/profiles',getProfiles)
Router.get('/profile/:id',getProfile)
Router.put('/profile/:id',updateProfile)
// Admin set password for a user (by profile id) without current password
Router.post('/profile/:id/set-password', setUserPassword)
Router.delete('/profile/:id',deleteProfile)
Router.get('/posts',getPosts)
Router.get('/posts/:id',getPost)
Router.put('/posts/:id',updatePost)
Router.delete('/posts/:id',deletePost)
Router.get('/watches',getWatches)
Router.get('/watches/:id',getWatch)
Router.put('/watches/:id',updateWatch)
Router.delete('/watches/:id',deleteWatch)
Router.get('/stories',getStories)
Router.delete('/stories/:id',deleteStory)
Router.post('/upload',upload.single('image'),uploadImage)
// Admin summary stats and recent activities
Router.get('/stats', getStats)
Router.get('/cloudinary/resources', isAdminAuth, listResources)
Router.post('/cloudinary/migrate', isAdminAuth, (req, res, next) => {
  if (!['superAdmin', 'admin'].includes(req.admin.role)) {
    return res.status(403).json({ message: 'Only administrators can migrate Cloudinary assets' });
  }
  return migrateResources(req, res, next);
})
Router.get('/cloudinary/migrate/:jobId', isAdminAuth, getMigrationStatus)
// Reports
Router.get('/reports/posts', getReportedPosts)
Router.get('/reports/profiles', getReportedProfiles)
Router.put('/reports/:id/status', updateReportStatus)
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