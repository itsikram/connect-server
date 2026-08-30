const Router = require("express").Router();
const {
  getNotifications,
  deleteAllNotifications,
  deleteNotification,
  postNotification,
  notificationView,
  notificationViewAll,
  registerDeviceToken,
  unregisterDeviceToken,
  unregisterAllOtherDeviceTokens,
  sendTestPush,
  getNewNotifications,
  rejectIncomingCallFromPush,
  notifyIncomingCallRingingFromPush,
  resolveLudoInviteNotifications,
  resolveChessInviteNotifications,
} = require("../controllers/notificationController");
const isAuth = require("../middlewares/isAuth");

Router.post("/", isAuth, postNotification);
Router.post("/view", isAuth, notificationView);
Router.post("/token/register", isAuth, registerDeviceToken);
Router.post("/token/unregister", isAuth, unregisterDeviceToken);
Router.post(
  "/token/unregister-all-others",
  isAuth,
  unregisterAllOtherDeviceTokens,
);
Router.post("/send-test", isAuth, sendTestPush);
Router.post("/call/reject-push", isAuth, rejectIncomingCallFromPush);
Router.post("/call/notify-ringing", isAuth, notifyIncomingCallRingingFromPush);
Router.post("/viewall", isAuth, notificationViewAll);
Router.get("/", isAuth, getNotifications);
Router.get("/new", isAuth, getNewNotifications);
Router.post("/delete", isAuth, deleteNotification);
Router.post("/deleteall", isAuth, deleteAllNotifications);
Router.post("/resolve-ludo-invite", isAuth, resolveLudoInviteNotifications);
Router.post("/resolve-chess-invite", isAuth, resolveChessInviteNotifications);

module.exports = Router;
