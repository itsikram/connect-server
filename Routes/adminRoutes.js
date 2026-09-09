const Router = require("express").Router();
const {signUp,login,deleteAccount,getProfiles,getProfile,updateProfile,deleteProfile,getPosts,getPost,updatePost,deletePost,getWatches,getWatch,updateWatch,deleteWatch,getStories,deleteStory,setUserPassword,getStats,getReportedPosts,getReportedProfiles,updateReportStatus,forgotPassword,resetPassword} = require('../controllers/adminController')
const {uploadImage} = require('../controllers/uploadControllers')
const {listResources, migrateResources, getMigrationStatus} = require('../controllers/cloudinaryController')
const isAdminAuth = require('../middlewares/isAdminAuth');
const multer = require('multer');

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

const {
  getAdminAiSettings,
  updateAdminAiSettings,
  listAdminCursorModels,
  testAdminAiProvider,
} = require('../controllers/aiSettingsController');

Router.get('/ai-settings', isAdminAuth, getAdminAiSettings);
Router.put('/ai-settings', isAdminAuth, updateAdminAiSettings);
Router.get('/ai-settings/models', isAdminAuth, listAdminCursorModels);
Router.post('/ai-settings/test', isAdminAuth, testAdminAiProvider);

module.exports = Router;