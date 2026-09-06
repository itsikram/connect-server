const Profile = require("../models/Profile");
const mongoose = require("mongoose");
const { saveNotification } = require("./notificationController");
const { sendPushToProfile } = require("../utils/pushNotifications");
const sendEmailNotification = require("../utils/sendEmailNotification.js");
const checkIsActive = require("../utils/checkIsActive.js");
const { asId, idsMatch, listHasId } = require("../utils/ids");

const emitFriendCacheUpdate = (io, profileId, list, action, targetProfileId) => {
  if (!io || !profileId) return;
  io.to(String(profileId)).emit("friendCacheUpdate", {
    profileId: String(profileId),
    list,
    action,
    targetProfileId: targetProfileId ? String(targetProfileId) : undefined,
  });
};

const emitRelationshipUpdate = (io, profileId, actorId, targetId, status) => {
  if (!io || !profileId) return;
  io.to(String(profileId)).emit("friendRelationshipUpdate", {
    actorId: String(actorId),
    targetId: String(targetId),
    status,
  });
};

exports.postFrndReq = async (req, res, next) => {
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
        .json({ message: "Cannot send friend request to yourself" });
    }

    if (listHasId(myProfile.friends, profile)) {
      return res.json({
        message: "Already Friend",
        alreadyFriend: true,
      });
    }

    let frndProfile = await Profile.findById(profile).populate("user");

    if (!frndProfile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    if (listHasId(frndProfile.friends, myProfile._id)) {
      return res.json({
        message: "Already Friend",
        alreadyFriend: true,
      });
    }

    if (listHasId(frndProfile.friendReqs, myProfile._id)) {
      return res.json({
        message: "Already Requested",
        alreadyRequested: true,
      });
    }

    const updated = await Profile.findOneAndUpdate(
      {
        _id: frndProfile._id,
        friendReqs: { $ne: myProfile._id },
      },
      { $addToSet: { friendReqs: myProfile._id } },
      { new: true, select: "_id friendReqs" },
    );

    if (!updated) {
      const currentRequest = await Profile.exists({
        _id: frndProfile._id,
        friendReqs: myProfile._id,
      });
      if (currentRequest) {
        return res.json({
          message: "Already Requested",
          alreadyRequested: true,
        });
      }
      return res.status(500).json({ message: "Failed to send friend request" });
    }

    if (!listHasId(updated.friendReqs, myProfile._id)) {
      return res.status(500).json({ message: "Failed to send friend request" });
    }

    const receiverId = asId(frndProfile._id);
    const senderId = asId(myProfile._id);

    emitFriendCacheUpdate(io, receiverId, "requests", "refresh");
    emitFriendCacheUpdate(io, senderId, "suggestions", "remove", receiverId);
    emitRelationshipUpdate(io, receiverId, senderId, receiverId, "incoming");
    emitRelationshipUpdate(io, senderId, senderId, receiverId, "incoming");

    try {
      let { isActive } = await checkIsActive(profile);
      const activeBrowserIds =
        frndProfile.browserIds
          ?.filter((browser) => browser?.isActive)
          ?.map((browser) => browser.browserId)
          .filter(Boolean) || [];

      if (io && typeof io.to === "function") {
        await saveNotification(io, {
          receiverId,
          text: myProfile.fullName + " Sent you friend Request",
          link: "/" + senderId,
          icon: myProfile.profilePic,
          type: "friendReq",
          browserIds: activeBrowserIds,
          data: {
            senderId,
            senderName: myProfile.fullName,
            senderProfilePic: myProfile.profilePic,
          },
        });
        io.to(receiverId).emit("friendRequestNotification", {
          senderName: myProfile.fullName,
          senderPP: myProfile.profilePic,
          senderId,
        });
      }

      if (!isActive) {
        try {
          await sendPushToProfile(receiverId, {
            title: "New friend request",
            body: `${myProfile.fullName} sent you a friend request`,
            data: { type: "friend_request", senderId },
          });
        } catch (e) {}
        Promise.resolve(
          sendEmailNotification(
            frndProfile?.user?.email,
            "You've received a friend requiest",
            myProfile.fullName + " Sent you friend Request On Connect",
            myProfile.fullName,
          ),
        ).catch(() => {});
      }
    } catch (notifyErr) {
      console.error("Friend request saved but notify failed:", notifyErr);
    }

    return res.json({
      success: true,
      message: "Friend request sent",
      _id: asId(updated._id),
    });
  } catch (error) {
    next(error);
  }
};

exports.postBlockFrnd = async (req, res, next) => {
  try {
    let friendId = req.body.friendId;
    let profile = req.profile;

    let updateProfile = await Profile.findOneAndUpdate(
      { _id: profile._id },
      {
        $push: {
          blockedUsers: friendId,
        },
      },
    );

    if (updateProfile) {
      // Emit real-time block to both users (personal rooms + shared chat room)
      try {
        const io = req.app.get("io");
        if (io) {
          const by = String(profile._id);
          const target = String(friendId);
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

    const friendId = req.query.friendId || req.body.friendId;
    const myId = req.profile?._id;
    if (!friendId || !mongoose.Types.ObjectId.isValid(String(friendId))) {
      return res.status(400).json({ message: "Invalid or missing friendId" });
    }
    if (!myId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const [me, friend] = await Promise.all([
      Profile.findById(myId).select("blockedUsers"),
      Profile.findById(friendId).select("blockedUsers"),
    ]);

    if (!friend) {
      return res.status(404).json({ message: "User not found" });
    }

    return res.status(200).json({
      iBlocked: listHasId(me?.blockedUsers, friendId),
      blockedMe: listHasId(friend?.blockedUsers, myId),
    });
  } catch (error) {
    next(error);
  }
};
exports.postUnblockFrnd = async (req, res, next) => {
  try {
    let friendId = req.body.friendId;
    let profile = req.profile;

    let updateProfile = await Profile.findOneAndUpdate(
      { _id: profile._id },
      {
        $pull: {
          blockedUsers: friendId,
        },
      },
    );

    if (updateProfile) {
      // Emit real-time unblock to both users (personal rooms + shared chat room)
      try {
        const io = req.app.get("io");
        if (io) {
          const by = String(profile._id);
          const target = String(friendId);
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

exports.getFrndReq = async (req, res, next) => {
  try {
    let myProfile = req.profile;
    let myProfileReqsId = [
      ...new Set((myProfile.friendReqs || []).map((id) => String(id))),
    ];
    let getFrndReqsInfo = await Profile.find({
      _id: myProfileReqsId,
    })
      .populate({
        path: "user",
        select: ["firstName", "surname"],
      })
      .select("profilePic")
      .sort({ createdAt: -1 });
    return res.status(200).json(getFrndReqsInfo);
  } catch (error) {
    next(error);
  }
};
exports.getProfileFrnd = async (req, res, next) => {
  try {
    let profile = req.query.profile;

    if (profile == false) return next();
    let isSingle = req.query.single && req.query.single;
    if (isSingle) {
      let friendData = await profile.findOne({ _id: profile });
      return res.json(friendData);
    }

    let friendProfile = await Profile.findOne({
      _id: profile,
    })
      .select(["friends"])
      .populate({
        path: "friends",
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

    const friendsData = [];
    const seenFriendIds = new Set();
    for (const friend of friendProfile?.friends || []) {
      const friendId = String(friend?._id || "");
      if (friendId && !seenFriendIds.has(friendId)) {
        seenFriendIds.add(friendId);
        friendsData.push(friend);
      }
    }
    res.json(friendsData);
  } catch (error) {
    next(error);
  }
};

exports.getProfileSuggetions = async (req, res, next) => {
  try {
    let profile = req.profile;
    let myFriends = req.profile.friends;

    let getFrndSuggetions = await Profile.find({
      _id: {
        $nin: myFriends,
        $ne: profile._id,
      },
    }).populate("user");

    res.json(getFrndSuggetions);
  } catch (error) {
    next(error);
  }
};

exports.postFrndAccept = async (req, res, next) => {
  try {
    let profile = req.body.profile;

    let myProfile = req.profile;
    let io = req.app.get("io");
    if (!profile || !mongoose.Types.ObjectId.isValid(profile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    const friendProfile = await Profile.findById(profile);
    if (!friendProfile) {
      return res.status(404).json({ message: "Profile not found" });
    }

    const acceptedRequest = await Profile.findOneAndUpdate(
      {
        _id: myProfile._id,
        friendReqs: profile,
      },
      { $pull: { friendReqs: profile } },
      { new: true, select: "_id" },
    );
    if (!acceptedRequest) {
      return res.status(409).json({ message: "Friend request is no longer pending" });
    }

    let updateFrndProfile = await Profile.findOneAndUpdate(
      { _id: profile },
      {
        $addToSet: {
          friends: myProfile._id,
        },
      },
    );
    let updateMyProfile = await Profile.findByIdAndUpdate(
      { _id: myProfile._id },
      {
        $addToSet: {
          friends: profile,
        },
      },
    );

    // Get the friend's profile to access browser IDs
    const activeBrowserIds =
      friendProfile?.browserIds
        ?.filter((browser) => browser.isActive)
        ?.map((browser) => browser.browserId) || [];

    let notificationData = {
      receiverId: profile,
      text: myProfile.fullName + " Accepted your friend Request",
      link: "/" + myProfile._id,
      icon: myProfile.profilePic,
      type: "friendReqAccept",
      browserIds: activeBrowserIds,
      data: {
        senderId: myProfile._id,
        senderName: myProfile.fullName,
        senderProfilePic: myProfile.profilePic,
      },
    };

    saveNotification(io, notificationData);

    // Also emit specific socket event for friend request acceptance
    io.to(profile).emit("friendRequestAcceptNotification", {
      senderName: myProfile.fullName,
      senderPP: myProfile.profilePic,
      senderId: myProfile._id,
    });
    emitFriendCacheUpdate(io, myProfile._id, "requests", "remove", profile);
    emitFriendCacheUpdate(io, myProfile._id, "suggestions", "remove", profile);
    emitFriendCacheUpdate(io, profile, "suggestions", "remove", myProfile._id);
    emitRelationshipUpdate(io, myProfile._id, myProfile._id, profile, "friends");
    emitRelationshipUpdate(io, profile, myProfile._id, profile, "friends");

    try {
      const { isActive } = await checkIsActive(profile);
      if (!isActive) {
        await sendPushToProfile(profile, {
          title: "Friend request accepted",
          body: `${myProfile.fullName} accepted your friend request`,
          data: { type: "friend_accept", senderId: String(myProfile._id) },
        });
      }
    } catch (e) {}

    return res.status(200).json({
      message: "Friend Request Accepted",
    });
  } catch (error) {
    next(error);
  }
};

exports.postFrndDelete = async (req, res, next) => {
  try {
    let friendProfileId = req.body.profile;
    let myProfile = req.profile;

    let updateMyProfile = await Profile.findOneAndUpdate(
      {
        _id: myProfile._id,
      },
      {
        $pull: {
          friendReqs: friendProfileId,
        },
      },
      { new: true },
    );

    if (updateMyProfile) {
      const io = req.app.get("io");
      emitFriendCacheUpdate(io, myProfile._id, "requests", "remove", friendProfileId);
      emitFriendCacheUpdate(io, friendProfileId, "suggestions", "refresh");
      emitRelationshipUpdate(io, myProfile._id, myProfile._id, friendProfileId, "none");
      emitRelationshipUpdate(io, friendProfileId, myProfile._id, friendProfileId, "none");
    }
    res.json(updateMyProfile);
  } catch (error) {
    next(error);
  }
};

exports.postRemoveFrndReq = async (req, res, next) => {
  try {
    let frndProfileId = req.body.profile;
    let myProfile = req.profile;

    let updateFrnd = await Profile.findOneAndUpdate(
      {
        _id: frndProfileId,
      },
      {
        $pull: {
          friendReqs: myProfile._id,
        },
      },
      { new: true },
    );
    if (updateFrnd) {
      const io = req.app.get("io");
      emitFriendCacheUpdate(io, frndProfileId, "suggestions", "refresh");
      emitFriendCacheUpdate(io, myProfile._id, "suggestions", "refresh");
      emitRelationshipUpdate(io, frndProfileId, myProfile._id, frndProfileId, "none");
      emitRelationshipUpdate(io, myProfile._id, myProfile._id, frndProfileId, "none");
    }
    res.json(updateFrnd);
  } catch (e) {
    next(e);
  }
};

exports.postRemoveFrnd = async (req, res, next) => {
  try {
    let myProfile = req.profile;
    let frndProfile =
      req.body.profile || req.body.profileId || req.query.profileId;
    if (!frndProfile || !mongoose.Types.ObjectId.isValid(frndProfile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    let updateMyProfile = await Profile.findOneAndUpdate(
      {
        _id: myProfile._id,
      },
      {
        $pull: {
          friends: frndProfile,
        },
      },
    );

    let updateFrndProfile = await Profile.findByIdAndUpdate(
      { _id: frndProfile },
      {
        $pull: {
          friends: myProfile._id,
        },
      },
    );

    if (updateMyProfile && updateFrndProfile) {
      return res.json({
        message: "Friend removed From your profile",
      });
    }

    return res.status(404).json({ message: "Friend relationship not found" });
  } catch (error) {
    next(error);
  }
};
