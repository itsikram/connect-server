
const authRoutes = require('./authRoutes')
const profileRoutes = require('./profileRoutes')
const PostRoutes = require('./postRoutes')
const friendRoutes = require('./friendRoutes')
const reactRoutes = require('./reactRoutes')
const commentRoutes = require('./commentRoutes')
const uploadRoute = require('./uploadRoute')
const storyRoutes = require('./storyRoutes')
const settingRoutes = require('./settingRoutes')
const notificationRoutes = require('./notificationRoutes')
const messageRoutes = require('./messageRoutes')
const searchRoutes = require('./searchRoutes')
const path = require('path')
const watchRoutes = require('./watchRoutes')
const agoraRoutes = require('./agoraRoutes')
 
let rootRoute = async (req,res) => {
    return res.sendFile(path.join(__dirname, "build", "index.html"));
 
}
const routes = [
 
    {
        path: '/api/auth',
        handler: authRoutes
    },
    {
        path: '/api/profile',
        handler: profileRoutes
    },
    {
        path: '/api/post',
        handler: PostRoutes
    },
    {
        path: '/api/friend',
        handler: friendRoutes
    },
    {
        path: '/api/react',
        handler: reactRoutes
    },
    {
        path: '/api/comment',
        handler: commentRoutes
    }, {
        path: '/api/story',
        handler: storyRoutes
    }, {
        path: '/api/upload',
        handler: uploadRoute
    },
    {
        path: '/api/notification',
        handler: notificationRoutes
    },
    {
        path: '/api/message',
        handler: messageRoutes
    },
    {
        path: '/api/setting',
        handler: settingRoutes
    },
    {
        path: '/api/search',
        handler: searchRoutes
    },
    {
        path: '/api/watch',
        handler: watchRoutes
    },
    {
        path: '/api/agora',
        handler: agoraRoutes
    }
]
 
module.exports = app => {
 
    routes.forEach(r => {
 
        app.use(r.path,r.handler)
        
    })
}







