const { prisma, isValidId, jsonArray, populated, isDuplicate } = require("../utils/db");
const {
  findProfileWithGraph,
  graphIds,
  shapeProfile,
  GRAPH_INCLUDE,
  PRIVATE_OMIT,
} = require("../utils/profileGraph");
const { saveNotification } = require("./notificationController");
const { sendPushToProfile } = require("../utils/pushNotifications");
const sendEmailNotification = require("../utils/sendEmailNotification.js");
const checkIsActive = require("../utils/checkIsActive.js");
const { asId, idsMatch, listHasId } = require("../utils/ids");

const normalizeRelationTypes = (value) => {
  const values = Array.isArray(value) ? value : [value];
  return [...new Set(values.map((item) => String(item || "").trim()).filter((item) => item && item.length <= 80))];
};

const saveRelationships = async (first, second, relationTypes, createdBy) => {
  const [userA, userB] = [String(first), String(second)].sort();
  await Promise.all(relationTypes.map((relationType) =>
    prisma.relationship.upsert({
      where: { userA_userB_relationType: { userA, userB, relationType } },
      update: {},
      create: { userA, userB, relationType, createdBy: String(createdBy) },
    }),
  ));
};

/** Full profile (private push fields omitted) with graph arrays — the old `{ new: true }` result. */
const loadGraphProfile = (id) => findProfileWithGraph({ id: String(id) });

const withoutRequester = (relations, requester) =>
  jsonArray(relations).filter((item) => !idsMatch(item?.requester, requester));

/** Rewrite a profile's pendingConnectRelations Json array. */
const editPendingRelations = (profileId, change) =>
  prisma.$transaction(async (tx) => {
    const row = await tx.profile.findUnique({
      where: { id: String(profileId) },
      select: { pendingConnectRelations: true },
    });
    if (!row) return;
    await tx.profile.update({
      where: { id: String(profileId) },
      data: { pendingConnectRelations: change(jsonArray(row.pendingConnectRelations)) },
    });
  });

/** Insert a join row; a duplicate (already present) is not an error, like $addToSet. */
const addEdge = async (create) => {
  try {
    await create();
    return true;
  } catch (error) {
    if (isDuplicate(error)) return false;
    throw error;
  }
};

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
    const relationTypes = normalizeRelationTypes(req.body.relationTypes || req.body.relationType);
    if (!relationTypes.length) {
      return res.status(400).json({ message: "At least one relationship type is required" });
    }
    if (!profile || !isValidId(profile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    let io = req.app.get("io");

    let myProfile = await loadGraphProfile(req.profile._id);
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

    let connectProfile = await findProfileWithGraph(
      { id: String(profile) },
      { userSelect: { id: true, firstName: true, surname: true, email: true } },
    );
    if (connectProfile) {
      const pushFields = await prisma.profile.findUnique({
        where: { id: connectProfile.id },
        select: { browserIds: true },
      });
      connectProfile.browserIds = jsonArray(pushFields?.browserIds);
    }

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

    // The unique (profile, requester) row is the atomic "not already requested" guard.
    const requestAdded = await addEdge(() =>
      prisma.connectRequest.create({
        data: { profile: connectProfile.id, requester: String(myProfile._id) },
      }),
    );
    if (!requestAdded) {
      return res.json({
        message: "Already Requested",
        alreadyRequested: true,
      });
    }
    const updated = { _id: connectProfile.id };

    // Replace any stale entry for this requester with the new relation types.
    await editPendingRelations(connectProfile.id, (list) => [
      ...withoutRequester(list, myProfile._id),
      { requester: String(myProfile._id), relationTypes },
    ]);

    const receiverId = asId(connectProfile._id);
    const senderId = asId(myProfile._id);

    emitConnectCacheUpdate(io, receiverId, "requests", "refresh");
    emitConnectCacheUpdate(io, senderId, "sentRequests", "refresh");
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

    let updateProfile = null;
    if (connectId && isValidId(connectId)) {
      await addEdge(() =>
        prisma.block.create({ data: { profile: String(profile._id), blocked: String(connectId) } }),
      );
      updateProfile = { _id: profile._id };
    }

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
    if (!connectId || !isValidId(connectId)) {
      return res.status(400).json({ message: "Invalid or missing connectId" });
    }
    if (!myId) {
      return res.status(401).json({ message: "Authentication required" });
    }

    const connect = await prisma.profile.findUnique({
      where: { id: String(connectId) },
      select: { id: true },
    });

    if (!connect) {
      return res.status(404).json({ message: "User not found" });
    }

    const [iBlocked, blockedMe] = await Promise.all([
      prisma.block.count({ where: { profile: String(myId), blocked: String(connectId) } }),
      prisma.block.count({ where: { profile: String(connectId), blocked: String(myId) } }),
    ]);

    return res.status(200).json({
      iBlocked: iBlocked > 0,
      blockedMe: blockedMe > 0,
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

    let updateProfile = null;
    if (connectId != null) {
      await prisma.block.deleteMany({
        where: { profile: String(profile._id), blocked: String(connectId) },
      });
      updateProfile = { _id: profile._id };
    }

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
      ...new Set((await graphIds.connectReqs(myProfile._id)).map((id) => String(id))),
    ];
    let getConnectReqsInfo = populated(
      await prisma.profile.findMany({
        where: { id: { in: myProfileReqsId } },
        select: {
          id: true,
          profilePic: true,
          user: true,
          userDoc: { select: { id: true, firstName: true, surname: true } },
        },
        orderBy: { createdAt: "desc" },
      }),
      "user",
    );
    return res.status(200).json(getConnectReqsInfo);
  } catch (error) {
    next(error);
  }
};

exports.getSentConnectReq = async (req, res, next) => {
  try {
    const myProfileId = req.profile._id;
    const rows = await prisma.profile.findMany({
      where: { connectReqs: { some: { requester: String(myProfileId) } } },
      select: {
        id: true,
        profilePic: true,
        isVerified: true,
        fullName: true,
        username: true,
        user: true,
        userDoc: { select: { id: true, firstName: true, surname: true } },
        connectReqs: { select: { requester: true }, orderBy: { createdAt: "asc" } },
      },
      orderBy: { createdAt: "desc" },
    });
    const sentRequests = populated(rows, "user").map((row) => ({
      ...row,
      connectReqs: row.connectReqs.map((item) => item.requester),
    }));
    return res.status(200).json(sentRequests);
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
    if (!isValidId(profileId)) {
      return res.status(400).json({ message: "Invalid profile id" });
    }
    const isSingle = Boolean(req.query.single);
    if (isSingle) {
      const connectData = await prisma.profile.findUnique({
        where: { id: String(profileId) },
        omit: PRIVATE_OMIT,
        include: GRAPH_INCLUDE,
      });
      return res.json(shapeProfile(connectData));
    }

    const connectRows = await prisma.profileConnect.findMany({
      where: { profile: String(profileId) },
      orderBy: { createdAt: "asc" },
      select: {
        connectDoc: {
          select: {
            id: true,
            profilePic: true,
            fullName: true,
            displayName: true,
            nickname: true,
            username: true,
            banglaName: true,
            isActive: true,
            lastLocation: true,
            presentAddress: true,
            permanentAddress: true,
            user: true,
            // gender lets the AI Agent tell "call my mom" from "call my dad".
            userDoc: { select: { id: true, firstName: true, surname: true, profile: true, gender: true } },
          },
        },
      },
    });
    const connectProfile = {
      connects: connectRows.map((row) => populated(row.connectDoc, "user")).filter(Boolean),
    };

    const relationshipRows = await prisma.relationship.findMany({
      where: { OR: [{ userA: String(profileId) }, { userB: String(profileId) }] },
      select: { userA: true, userB: true, relationType: true },
    });
    const relationshipMap = new Map();
    relationshipRows.forEach((row) => {
      const otherId = String(row.userA) === String(profileId) ? String(row.userB) : String(row.userA);
      const types = relationshipMap.get(otherId) || [];
      if (!types.includes(row.relationType)) types.push(row.relationType);
      relationshipMap.set(otherId, types);
    });
    const connectsData = [];
    const seenConnectIds = new Set();
    for (const connect of connectProfile?.connects || []) {
      const connectId = String(connect?._id || "");
      if (connectId && !seenConnectIds.has(connectId)) {
        seenConnectIds.add(connectId);
        const connectData = connect.toObject ? connect.toObject() : connect;
        connectData.relationshipTypes = relationshipMap.get(connectId) || [];
        connectsData.push(connectData);
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

    const excluded = [...myConnects.map((id) => String(id?._id ?? id)), String(profile._id)];
    let getConnectSuggetions = (
      await prisma.profile.findMany({
        where: { id: { notIn: excluded } },
        omit: PRIVATE_OMIT,
        include: {
          ...GRAPH_INCLUDE,
          userDoc: { omit: { password: true, resetPasswordToken: true, resetPasswordExpire: true } },
        },
      })
    ).map(shapeProfile);

    res.json(getConnectSuggetions);
  } catch (error) {
    next(error);
  }
};

exports.postConnectAccept = async (req, res, next) => {
  try {
    let profile = req.body.profile;
    const requestedRelationTypes = normalizeRelationTypes(req.body.relationTypes || req.body.relationType);

    let myProfile = req.profile;
    let io = req.app.get("io");
    if (!profile || !isValidId(profile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    profile = String(profile);

    const connectProfile = await prisma.profile.findUnique({
      where: { id: profile },
      select: { id: true, browserIds: true },
    });
    if (!connectProfile) {
      return res.status(404).json({ message: "Profile not found" });
    }
    const myRow = await prisma.profile.findUnique({
      where: { id: String(myProfile._id) },
      select: { pendingConnectRelations: true },
    });
    const pendingRelation = jsonArray(myRow?.pendingConnectRelations).find((item) =>
      idsMatch(item.requester, profile),
    );
    const relationTypes = requestedRelationTypes.length
      ? requestedRelationTypes
      : normalizeRelationTypes(pendingRelation?.relationTypes);
    if (!relationTypes.length) {
      return res.status(400).json({ message: "At least one relationship type is required" });
    }

    const myId = String(myProfile._id);
    // Deleting the request row is the atomic claim: only one accept can win it.
    const { count: accepted } = await prisma.connectRequest.deleteMany({
      where: { profile: myId, requester: profile },
    });
    if (!accepted) {
      return res.status(409).json({ message: "Connect request is no longer pending" });
    }
    await editPendingRelations(myId, (list) => withoutRequester(list, profile));

    await addEdge(() => prisma.profileConnect.create({ data: { profile, connect: myId } }));
    await addEdge(() => prisma.profileConnect.create({ data: { profile: myId, connect: profile } }));
    const connectsOnly = async (id) => ({ _id: id, connects: await graphIds.connects(id) });
    let updateConnectProfile = await connectsOnly(profile);
    let updateMyProfile = await connectsOnly(myId);
    if (!updateConnectProfile || !updateMyProfile) {
      return res.status(500).json({ message: "Failed to update both connection lists" });
    }
    await saveRelationships(myProfile._id, profile, relationTypes, myProfile._id);

    // Get the connect's profile to access browser IDs
    const activeBrowserIds =
      jsonArray(connectProfile?.browserIds)
        .filter((browser) => browser.isActive)
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
    emitConnectCacheUpdate(io, profile, "sentRequests", "remove", myProfile._id);
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
      relationTypes,
      myProfile: updateMyProfile,
      connectProfile: updateConnectProfile,
    });
  } catch (error) {
    next(error);
  }
};

exports.getRequestStatus = async (req, res, next) => {
  try {
    const targetId = req.query.profileId || req.query.profile;
    if (!targetId || !isValidId(targetId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    const me = String(req.profile._id);
    const target = String(targetId);
    const [connected, outgoing, incoming] = await Promise.all([
      prisma.profileConnect.count({ where: { profile: me, connect: target } }),
      prisma.connectRequest.count({ where: { profile: target, requester: me } }),
      prisma.connectRequest.count({ where: { profile: me, requester: target } }),
    ]);
    return res.json({
      connected: connected > 0,
      outgoing: outgoing > 0,
      incoming: incoming > 0,
    });
  } catch (error) {
    next(error);
  }
};

exports.getRelationships = async (req, res, next) => {
  try {
    const targetId = req.query.profileId || req.query.profile;
    if (!targetId || !isValidId(targetId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    const me = String(req.profile._id);
    const target = String(targetId);
    const rows = await prisma.relationship.findMany({
      where: {
        OR: [
          { userA: me, userB: target },
          { userA: target, userB: me },
        ],
      },
      select: { id: true, relationType: true, createdAt: true },
    });
    return res.json({ relationTypes: rows.map((row) => row.relationType), relationships: rows });
  } catch (error) {
    next(error);
  }
};

exports.updateRelationships = async (req, res, next) => {
  try {
    const targetId = req.body.profileId || req.body.profile;
    const relationTypes = normalizeRelationTypes(req.body.relationTypes || req.body.relationType);
    if (!targetId || !isValidId(targetId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    if (!relationTypes.length) {
      return res.status(400).json({ message: "At least one relationship type is required" });
    }

    const isConnected = await prisma.profileConnect.count({
      where: { profile: String(req.profile._id), connect: String(targetId) },
    });
    if (!isConnected) {
      return res.status(403).json({ message: "Only connected profiles can edit this relationship" });
    }

    const [userA, userB] = [String(req.profile._id), String(targetId)].sort();
    await prisma.relationship.deleteMany({ where: { userA, userB } });
    await saveRelationships(req.profile._id, targetId, relationTypes, req.profile._id);
    const io = req.app.get("io");
    emitRelationshipUpdate(io, req.profile._id, req.profile._id, targetId, "updated");
    emitRelationshipUpdate(io, targetId, req.profile._id, targetId, "updated");
    return res.json({ relationTypes });
  } catch (error) {
    next(error);
  }
};

exports.postConnectDelete = async (req, res, next) => {
  try {
    let connectProfileId = req.body.profile;
    let myProfile = req.profile;
    if (!connectProfileId || !isValidId(connectProfileId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    await prisma.connectRequest.deleteMany({
      where: { profile: String(myProfile._id), requester: String(connectProfileId) },
    });
    let updateMyProfile = await loadGraphProfile(myProfile._id);

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
    if (!connectProfileId || !isValidId(connectProfileId)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }

    await prisma.connectRequest.deleteMany({
      where: { profile: String(connectProfileId), requester: String(myProfile._id) },
    });
    let updateConnect = await loadGraphProfile(connectProfileId);
    if (updateConnect) {
      const io = req.app.get("io");
      emitConnectCacheUpdate(io, connectProfileId, "suggestions", "refresh");
      emitConnectCacheUpdate(io, myProfile._id, "suggestions", "refresh");
      emitConnectCacheUpdate(io, myProfile._id, "sentRequests", "remove", connectProfileId);
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
    if (!connectProfile || !isValidId(connectProfile)) {
      return res.status(400).json({ message: "Invalid or missing profile id" });
    }
    connectProfile = String(connectProfile);
    const myId = String(myProfile._id);

    await prisma.profileConnect.deleteMany({
      where: {
        OR: [
          { profile: myId, connect: connectProfile },
          { profile: connectProfile, connect: myId },
        ],
      },
    });
    let updateMyProfile = await loadGraphProfile(myId);
    let updateConnectProfile = await loadGraphProfile(connectProfile);

    if (updateMyProfile && updateConnectProfile) {
      await prisma.relationship.deleteMany({
        where: {
          OR: [
            { userA: myId, userB: connectProfile },
            { userA: connectProfile, userB: myId },
          ],
        },
      });
      const io = req.app.get("io");
      emitConnectCacheUpdate(io, myProfile._id, "suggestions", "refresh");
      emitConnectCacheUpdate(io, connectProfile, "suggestions", "refresh");
      emitRelationshipUpdate(io, myProfile._id, myProfile._id, connectProfile, "none");
      emitRelationshipUpdate(io, connectProfile, myProfile._id, connectProfile, "none");
      return res.json({
        message: "Disconnected from your profile",
        myProfile: updateMyProfile,
        connectProfile: updateConnectProfile,
      });
    }

    return res.status(404).json({ message: "Connect relationship not found" });
  } catch (error) {
    next(error);
  }
};
