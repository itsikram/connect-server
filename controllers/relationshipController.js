const Profile = require("../models/Profile");
const mongoose = require("mongoose");
const { saveNotification } = require("./notificationController");
const { sendPushToProfile } = require("../utils/pushNotifications");
const sendEmailNotification = require("../utils/sendEmailNotification.js");
const checkIsActive = require("../utils/checkIsActive.js");
const { asId, idsMatch, listHasId } = require("../utils/ids");

const emitConnectCacheUpdate = (io, profileId, list, action, targetProfileId) => {
  if (!io || !profileId) return;
  io.to(String(profileId)).emit("connectCacheUpdate", {
    profileId: String(profileId),
    list,
    action,
    targetProfileId: targetProfileId ? String(targetProfileId) : undefined,
  });
};

const emitRelationshipUpdate = (io, profileId, actorId, targetId, status) => {
  if (!io || !profileId) return;
  io.to(String(profileId)).emit("connectRelationshipUpdate", {
    actorId: String(actorId),
    targetId: String(targetId),
    status,
  });
};

exports.postConnectReq = async (req, res, next) => {
  try {
    let profile = req.body.profile || req.body.profileId || req.query.profileId;
    if (profile && typeof profile === "object") {
      profile = profile._id || profile.id || profile.profileId;
    }
    profile = asId(profile);
    if (!profile || !mongoose.Types.ObjectId.isValid(profile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    let io = req.app.get("io");

    let myProfile = await Profile.findById(req.profile._id);
    if (!myProfile) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    if (idsMatch(myProfile._id, profile)) {
      return res
        .status(400)
        .json({ message: "Cannot send connect request to yourself" });
    }

    if (listHasId(myProfile.connects, profile)) {
      return res.json({
        message: "Already Connect",
        alreadyConnect: true,
      });
    }

    let connectProfile = await Profile.findById(profile).populate("user");

    if (!connectProfile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    if (listHasId(connectProfile.connects, myProfile._id)) {
      return res.json({
        message: "Already Connect",
        alreadyConnect: true,
      });
    }

    if (listHasId(connectProfile.connectReqs, myProfile._id)) {
      return res.json({
        message: "Already Requested",
        alreadyRequested: true,
      });
    }

    const updated = await Profile.findOneAndUpdate(
      {
        _id: connectProfile._id,
        connectReqs: { $ne: myProfile._id },
      },
      { $addToSet: { connectReqs: myProfile._id } },
      { new: true, select: "_id connectReqs" },
    );

    if (!updated) {
      const currentRequest = await Profile.exists({
        _id: connectProfile._id,
        connectReqs: myProfile._id,
      });
      if (currentRequest) {
        return res.json({
          message: "Already Requested",
          alreadyRequested: true,
        });
      }
      return res.status(500).json({ message: "Failed to send connect request" });
    }

    if (!listHasId(updated.connectReqs, myProfile._id)) {
      return res.status(500).json({ message: "Failed to send connect request" });
    }

    const receiverId = asId(connectProfile._id);
    const senderId = asId(myProfile._id);

    emitConnectCacheUpdate(io, receiverId, "requests", "refresh");
    emitConnectCacheUpdate(io, senderId, "suggestions", "remove", receiverId);
    emitRelationshipUpdate(io, receiverId, senderId, receiverId, "incoming");
    emitRelationshipUpdate(io, senderId, senderId, receiverId, "incoming");

    try {
      let { isActive } = await checkIsActive(profile);
      const activeBrowserIds =
        connectProfile.browserIds
          ?.filter((browser) => browser?.isActive)
          ?.map((browser) => browser.browserId)
          .filter(Boolean) || [];

      if (io && typeof io.to === "function") {
        await saveNotification(io, {
          receiverId,
          text: myProfile.fullName + " Sent you connect Request",
          link: "/" + senderId,
          icon: myProfile.profilePic,
          type: "connectReq",
          browserIds: activeBrowserIds,
          data: {
            senderId,
            senderName: myProfile.fullName,
            senderProfilePic: myProfile.profilePic,
          },
        });
        io.to(receiverId).emit("connectRequestNotification", {
          senderName: myProfile.fullName,
          senderPP: myProfile.profilePic,
          senderId,
        });
      }

      if (!isActive) {
        try {
          await sendPushToProfile(receiverId, {
            title: "New connect request",
            body: `${myProfile.fullName} sent you a connect request`,
            data: { type: "connect_request", senderId },
          });
        } catch (e) {}
        Promise.resolve(
          sendEmailNotification(
            connectProfile?.user?.email,
            "You've received a connect requiest",
            myProfile.fullName + " Sent you connect Request On Connect",
            myProfile.fullName,
          ),
        ).catch(() => {});
      }
    } catch (notifyErr) {
      console.error("Connect request saved but notify failed:", notifyErr);
    }

    return res.json({
      success: true,
      message: "Connect request sent",
      _id: asId(updated._id),
    });
  } catch (error) {
    next(error);
  }
};

exports.postBlockConnect = async (req, res, next) => {
  try {
    // friendId is accepted only as a legacy request-body compatibility key.
    let connectId = req.body.connectId || req.body.friendId;
    let profile = req.profile;

    let updateProfile = await Profile.findOneAndUpdate(
      { _id: profile._id },
      {
        $push: {
          blockedUsers: connectId,
        },
      },
    );

    if (updateProfile) {
      // Emit real-time block to both users (personal rooms + shared chat room)
      try {
        const io = req.app.get("io");
        if (io) {
          const by = String(profile._id);
          const target = String(connectId);
          const payload = { by, target };
          const chatRoom = [by, target].sort().join("_");
          io.to(by).emit("userBlocked", payload);
          io.to(target).emit("blockedByUser", payload);
          io.to(chatRoom).emit("userBlocked", payload);
          io.to(chatRoom).emit("blockedByUser", payload);
        }
      } catch (e) {}

      return res.status(200).json({ message: "User Block Successfully" });
    }

    return res.status(400).json({ message: "User Cannot Be blocked" });
  } catch (error) {
    next(error);
  }
};

exports.getBlockStatus = async (req, res, next) => {
  try {
    // Block state is user-specific and must not be served from a cached ETag.
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });

    const connectId =
      req.query.connectId ||
      req.body.connectId ||
      // Legacy clients may still send friendId; never expose it in responses.
      req.query.friendId ||
      req.body.friendId;
    const myId = req.profile?._id;
    if (!connectId || !mongoose.Types.ObjectId.isValid(String(connectId))) {
      return res.status(400).json({ message: "Invalid or missing connectId" });
    }
    if (!myId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const [me, connect] = await Promise.all([
      Profile.findById(myId).select("blockedUsers"),
      Profile.findById(connectId).select("blockedUsers"),
    ]);

    if (!connect) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      iBlocked: listHasId(me?.blockedUsers, connectId),
      blockedMe: listHasId(connect?.blockedUsers, myId),
    });
  } catch (error) {
    next(error);
  }
};
exports.postUnblockConnect = async (req, res, next) => {
  try {
    // friendId is accepted only as a legacy request-body compatibility key.
    let connectId = req.body.connectId || req.body.friendId;
    let profile = req.profile;

    let updateProfile = await Profile.findOneAndUpdate(
      { _id: profile._id },
      {
        $pull: {
          blockedUsers: connectId,
        },
      },
    );

    if (updateProfile) {
      // Emit real-time unblock to both users (personal rooms + shared chat room)
      try {
        const io = req.app.get("io");
        if (io) {
          const by = String(profile._id);
          const target = String(connectId);
          const payload = { by, target };
          const chatRoom = [by, target].sort().join("_");
          io.to(by).emit("userUnblocked", payload);
          io.to(target).emit("unblockedByUser", payload);
          io.to(chatRoom).emit("userUnblocked", payload);
          io.to(chatRoom).emit("unblockedByUser", payload);
        }
      } catch (e) {}

      return res.status(200).json({ message: "User Unlock Successfully" });
    }

    return res.status(400).json({ message: "User Cannot Be unblocked" });
  } catch (error) {
    next(error);
  }
};

exports.getConnectReq = async (req, res, next) => {
  try {
    let myProfile = req.profile;
    let myProfileReqsId = [
      ...new Set((myProfile.connectReqs || []).map((id) => String(id))),
    ];
    let getConnectReqsInfo = await Profile.find({
      _id: myProfileReqsId,
    })
      .populate({
        path: "user",
        select: ["firstName", "surname"],
      })
      .select("profilePic")
      .sort({ createdAt: -1 });
    return res.status(200).json(getConnectReqsInfo);
  } catch (error) {
    next(error);
  }
};
exports.getProfileConnect = async (req, res, next) => {
  try {
    const profileId = req.query.profile || req.query.profileId;

    if (!profileId || profileId === "false") {
      return res.status(400).json({ message: "Profile ID is required" });
    }
    if (!mongoose.Types.ObjectId.isValid(String(profileId))) {
      return res.status(400).json({ message: "Invalid profile id" });
    }
    const isSingle = Boolean(req.query.single);
    if (isSingle) {
      const connectData = await Profile.findOne({ _id: profileId });
      return res.json(connectData);
    }

    const connectProfile = await Profile.findOne({
      _id: profileId,
    })
      .select(["connects"])
      .populate({
        path: "connects",
        select: [
          "profilePic",
          "fullName",
          "displayName",
          "nickname",
          "username",
          "banglaName",
          "isActive",
          "lastLocation",
          "presentAddress",
          "permanentAddress",
        ],
        populate: {
          path: "user",
          select: ["firstName", "surname", "profile"],
        },
      });

    const connectsData = [];
    const seenConnectIds = new Set();
    for (const connect of connectProfile?.connects || []) {
      const connectId = String(connect?._id || "");
      if (connectId && !seenConnectIds.has(connectId)) {
        seenConnectIds.add(connectId);
        connectsData.push(connect);
      }
    }
    res.json(connectsData);
  } catch (error) {
    next(error);
  }
};

exports.getProfileSuggetions = async (req, res, next) => {
  try {
    let profile = req.profile;
    let myConnects = req.profile.connects || [];

    let getConnectSuggetions = await Profile.find({
      _id: {
        $nin: myConnects,
        $ne: profile._id,
      },
    }).populate("user");

    res.json(getConnectSuggetions);
  } catch (error) {
    next(error);
  }
};

exports.postConnectAccept = async (req, res, next) => {
  try {
    let profile = req.body.profile;

    let myProfile = req.profile;
    let io = req.app.get("io");
    if (!profile || !mongoose.Types.ObjectId.isValid(profile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    const connectProfile = await Profile.findById(profile);
    if (!connectProfile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const acceptedRequest = await Profile.findOneAndUpdate(
      {
        _id: myProfile._id,
        connectReqs: profile,
      },
      { $pull: { connectReqs: profile } },
      { new: true, select: "_id" },
    );
    if (!acceptedRequest) {
      return res.status(409).json({ message: "Connect request is no longer pending" });
    }

    let updateConnectProfile = await Profile.findOneAndUpdate(
      { _id: profile },
      {
        $addToSet: {
          connects: myProfile._id,
        },
      },
    );
    let updateMyProfile = await Profile.findByIdAndUpdate(
      { _id: myProfile._id },
      {
        $addToSet: {
          connects: profile,
        },
      },
    );

    // Get the connect's profile to access browser IDs
    const activeBrowserIds =
      connectProfile?.browserIds
        ?.filter((browser) => browser.isActive)
        ?.map((browser) => browser.browserId) || [];

    let notificationData = {
      receiverId: profile,
      text: myProfile.fullName + " Accepted your connect Request",
      link: "/" + myProfile._id,
      icon: myProfile.profilePic,
      type: "connectReqAccept",
      browserIds: activeBrowserIds,
      data: {
        senderId: myProfile._id,
        senderName: myProfile.fullName,
        senderProfilePic: myProfile.profilePic,
      },
    };

    saveNotification(io, notificationData);

    // Also emit specific socket event for connect request acceptance
    if (io && typeof io.to === "function") {
      io.to(profile).emit("connectRequestAcceptNotification", {
        senderName: myProfile.fullName,
        senderPP: myProfile.profilePic,
        senderId: myProfile._id,
      });
    }
    emitConnectCacheUpdate(io, myProfile._id, "requests", "remove", profile);
    emitConnectCacheUpdate(io, myProfile._id, "suggestions", "remove", profile);
    emitConnectCacheUpdate(io, profile, "suggestions", "remove", myProfile._id);
    emitRelationshipUpdate(io, myProfile._id, myProfile._id, profile, "connects");
    emitRelationshipUpdate(io, profile, myProfile._id, profile, "connects");

    try {
      const { isActive } = await checkIsActive(profile);
      if (!isActive) {
        await sendPushToProfile(profile, {
          title: "Connect request accepted",
          body: `${myProfile.fullName} accepted your connect request`,
          data: { type: "connect_accept", senderId: String(myProfile._id) },
        });
      }
    } catch (e) {}

    return res.status(200).json({
      message: "Connect Request Accepted",
    });
  } catch (error) {
    next(error);
  }
};

exports.postConnectDelete = async (req, res, next) => {
  try {
    let connectProfileId = req.body.profile;
    let myProfile = req.profile;
    if (!connectProfileId || !mongoose.Types.ObjectId.isValid(connectProfileId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    let updateMyProfile = await Profile.findOneAndUpdate(
      {
        _id: myProfile._id,
      },
      {
        $pull: {
          connectReqs: connectProfileId,
        },
      },
      { new: true },
    );

    if (updateMyProfile) {
      const io = req.app.get("io");
      emitConnectCacheUpdate(io, myProfile._id, "requests", "remove", connectProfileId);
      emitConnectCacheUpdate(io, connectProfileId, "suggestions", "refresh");
      emitRelationshipUpdate(io, myProfile._id, myProfile._id, connectProfileId, "none");
      emitRelationshipUpdate(io, connectProfileId, myProfile._id, connectProfileId, "none");
    }
    res.json(updateMyProfile);
  } catch (error) {
    next(error);
  }
};

exports.postRemoveConnectReq = async (req, res, next) => {
  try {
    let connectProfileId = req.body.profile;
    let myProfile = req.profile;
    if (!connectProfileId || !mongoose.Types.ObjectId.isValid(connectProfileId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    let updateConnect = await Profile.findOneAndUpdate(
      {
        _id: connectProfileId,
      },
      {
        $pull: {
          connectReqs: myProfile._id,
        },
      },
      { new: true },
    );
    if (updateConnect) {
      const io = req.app.get("io");
      emitConnectCacheUpdate(io, connectProfileId, "suggestions", "refresh");
      emitConnectCacheUpdate(io, myProfile._id, "suggestions", "refresh");
      emitRelationshipUpdate(io, connectProfileId, myProfile._id, connectProfileId, "none");
      emitRelationshipUpdate(io, myProfile._id, myProfile._id, connectProfileId, "none");
    }
    res.json(updateConnect);
  } catch (e) {
    next(e);
  }
};

exports.postDisconnect = async (req, res, next) => {
  try {
    let myProfile = req.profile;
    let connectProfile =
      req.body.profile || req.body.profileId || req.query.profileId;
    if (!connectProfile || !mongoose.Types.ObjectId.isValid(connectProfile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    let updateMyProfile = await Profile.findOneAndUpdate(
      {
        _id: myProfile._id,
      },
      {
        $pull: {
          connects: connectProfile,
        },
      },
    );

    let updateConnectProfile = await Profile.findByIdAndUpdate(
      { _id: connectProfile },
      {
        $pull: {
          connects: myProfile._id,
        },
      },
    );

    if (updateMyProfile && updateConnectProfile) {
      return res.json({
        message: "Disconnected from your profile",
      });
    }

    return res.status(404).json({ message: "Connect relationship not found" });
  } catch (error) {
    next(error);
  }
};
