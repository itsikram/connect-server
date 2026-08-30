const authRoutes = require("./authRoutes");
const profileRoutes = require("./profileRoutes");
const PostRoutes = require("./postRoutes");
const friendRoutes = require("./friendRoutes");
const reactRoutes = require("./reactRoutes");
const commentRoutes = require("./commentRoutes");
const uploadRoute = require("./uploadRoute");
const storyRoutes = require("./storyRoutes");
const settingRoutes = require("./settingRoutes");
const notificationRoutes = require("./notificationRoutes");
const messageRoutes = require("./messageRoutes");
const searchRoutes = require("./searchRoutes");
const path = require("path");
const watchRoutes = require("./watchRoutes");
const agoraRoutes = require("./agoraRoutes");
const adminRoutes = require("./adminRoutes");
const connectRoutes = require("./connectRoutes");
const webNotificationRoutes = require("./webNotificationRoutes");
const ludoRoutes = require("./ludoRoutes");
const notesRoutes = require("./notesRoutes");
const tasksRoutes = require("./tasksRoutes");
const timerRoutes = require("./timerRoutes");
const flashcardsRoutes = require("./flashcardsRoutes");
const calendarRoutes = require("./calendarRoutes");
const habitsRoutes = require("./habitsRoutes");
const portfolioRoutes = require("./portfolioRoutes");
const locationRoutes = require("./locationRoutes");
const aiChatRoutes = require("./aiChatRoutes");
const savedVideoRoutes = require("./savedVideoRoutes");

let rootRoute = async (req, res) => {
  return res.sendFile(path.join(__dirname, "build", "index.html"));
};
const routes = [
  {
    path: "/api/auth",
    handler: authRoutes,
  },
  {
    path: "/api/profile",
    handler: profileRoutes,
  },
  {
    path: "/api/post",
    handler: PostRoutes,
  },
  {
    path: "/api/friend",
    handler: friendRoutes,
  },
  {
    path: "/api/react",
    handler: reactRoutes,
  },
  {
    path: "/api/comment",
    handler: commentRoutes,
  },
  {
    path: "/api/story",
    handler: storyRoutes,
  },
  {
    path: "/api/upload",
    handler: uploadRoute,
  },
  {
    path: "/api/notification",
    handler: notificationRoutes,
  },
  {
    path: "/api/message",
    handler: messageRoutes,
  },
  {
    path: "/api/setting",
    handler: settingRoutes,
  },
  {
    path: "/api/search",
    handler: searchRoutes,
  },
  {
    path: "/api/watch",
    handler: watchRoutes,
  },
  {
    path: "/api/agora",
    handler: agoraRoutes,
  },
  {
    path: "/api/admin",
    handler: adminRoutes,
  },
  {
    path: "/api/connect",
    handler: connectRoutes,
  },
  {
    path: "/api/web-notification",
    handler: webNotificationRoutes,
  },
  {
    path: "/api/ludo",
    handler: ludoRoutes,
  },
  {
    path: "/api/notes",
    handler: notesRoutes,
  },
  {
    path: "/api/tasks",
    handler: tasksRoutes,
  },
  {
    path: "/api/timer",
    handler: timerRoutes,
  },
  {
    path: "/api/flashcards",
    handler: flashcardsRoutes,
  },
  {
    path: "/api/calendar",
    handler: calendarRoutes,
  },
  {
    path: "/api/habits",
    handler: habitsRoutes,
  },
  {
    path: "/api/portfolio",
    handler: portfolioRoutes,
  },
  {
    path: "/api/location",
    handler: locationRoutes,
  },
  {
    path: "/api/ai-chat",
    handler: aiChatRoutes,
  },
  {
    path: "/api/saved-videos",
    handler: savedVideoRoutes,
  },
];

module.exports = (app) => {
  routes.forEach((r) => {
    app.use(r.path, r.handler);
  });
};
