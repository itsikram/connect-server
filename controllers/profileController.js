const { prisma, isValidId } = require("../utils/db");
const presence = require("../sockets/presence");
const {
  USER_PUBLIC_SELECT,
  USER_OWN_SELECT,
  GRAPH_INCLUDE,
  shapeProfile,
  findProfileWithGraph,
  graphIds,
} = require("../utils/profileGraph");
const { asId, listHasId } = require("../utils/ids");
const { saveNotification } = require("./notificationController");
const { sendPushToProfile } = require("../utils/pushNotifications");
const { deleteCloudinaryResources } = require("../utils/cloudinaryCleanup");

const MONGO_ID_RE = /^[a-fA-F0-9]{24}$/;
const LITE_PROFILE_SELECT = {
  id: true,
  fullName: true,
  displayName: true,
  username: true,
  nickname: true,
  profilePic: true,
  coverPic: true,
  bio: true,
  isOfficial: true,
  isVerified: true,
  isActive: true,
  lastActive: true,
  lastLocation: true,
  appMenuOrder: true,
  user: true,
  ...GRAPH_INCLUDE,
};

// Profile with `user` populated (own fields) and graph arrays, as returned by
// the old findByIdAndUpdate(..., { new: true }).populate("user").
const loadOwnProfile = (profileId) =>
  findProfileWithGraph({ id: String(profileId) }, { userSelect: USER_OWN_SELECT });

// Plain profile with graph arrays, as returned by an unpopulated findByIdAndUpdate.
const loadPlainProfile = async (profileId) =>
  shapeProfile(
    await prisma.profile.findUnique({
      where: { id: String(profileId) },
      include: GRAPH_INCLUDE,
    }),
  );

// Keep only real Profile columns from a client payload (Mongoose ignored the rest).
const { Prisma } = require("@prisma/client");
const PROFILE_WRITABLE = new Set(
  Object.keys(Prisma.ProfileScalarFieldEnum).filter(
    (key) => !["id", "user", "createdAt", "updatedAt", "isOfficial", "isVerified"].includes(key),
  ),
);
const profileData = (body = {}) => {
  const data = {};
  for (const [key, value] of Object.entries(body || {})) {
    if (PROFILE_WRITABLE.has(key) && value !== undefined) data[key] = value;
  }
  return data;
};

const isMongoId = (value) => MONGO_ID_RE.test(String(value || ""));

const isOwnProfileRequest = (req, profileId) => {
  const ownId = req.profile?._id;
  if (!ownId || !profileId) return false;
  if (String(ownId) === String(profileId)) return true;
  const ownUsername = req.profile?.username;
  return Boolean(ownUsername && String(ownUsername) === String(profileId));
};

// Live socket presence first, then a fresh DB flag (see sockets/presence.js).
const computeIsActive = (profile) =>
  Boolean(profile) && presence.statusFromProfile(profile).isActive;

const loadProfileDocument = async (
  profileId,
  { lite = false, includePrivateUserFields = false } = {},
) => {
  if (!profileId) return null;

  const where = isMongoId(profileId)
    ? { id: String(profileId) }
    : { username: String(profileId) };

  const userSelect = includePrivateUserFields
    ? USER_OWN_SELECT
    : USER_PUBLIC_SELECT;

  if (lite) {
    const row = await prisma.profile.findFirst({
      where,
      select: { ...LITE_PROFILE_SELECT, userDoc: { select: userSelect } },
    });
    return shapeProfile(row);
  }

  return findProfileWithGraph(where, { userSelect, populateConnects: true });
};

exports.prefileHasStory = async function (req, res, next) {
  try {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    let profileId = req.query.profileId;
    
    if (!profileId) {
      return res.status(400).json({ message: "profileId is required", hasStory: "no" });
    }
    
    if (isValidId(profileId)) {
      let hasStory = await prisma.story.findFirst({
        where: {
          author: String(profileId),
          createdAt: { gte: twentyFourHoursAgo },
        },
        select: { id: true },
      });
      if (hasStory == null) {
        return res.status(200).json({ message: "Story Not Available", hasStory: "no" });
      } else {
        return res.status(200).json({ message: "Story Available", hasStory: "yes" });
      }
    } else {
      return res.status(400).json({ message: "Invalid profileId format", hasStory: "no" });
    }
  } catch (error) {
    console.error("Error in prefileHasStory:", error);
    return res.status(500).json({ message: "Internal server error", error: error.message });
  }
};
exports.getProfileImages = async function (req, res, next) {
  let { profileId } = req.query;
  try {
    if (!isValidId(profileId)) return;
    // Mongo's { $ne: "null" } also matched documents without photos.
    let profileImages = await prisma.post.findMany({
      where: {
        author: String(profileId),
        OR: [{ photos: null }, { photos: { not: "null" } }],
      },
      orderBy: { id: "asc" },
    });

    if (profileImages) {
      return res.json(profileImages).status(200);
    }

    return next();
  } catch (error) {
    next(error);
  }

  return next();
};

// Unauthenticated, search-engine-facing view of a profile (used by the web
// server to render /:username for Google and for logged-out visitors). Only
// display fields are returned, and only when the owner's posts are Public;
// any other postVisibility opts the profile out of search engines.
exports.publicProfileGet = async function (req, res) {
  try {
    const username = String(req.params.username || "").trim();
    if (!username || username.length > 64) {
      return res.status(404).json({ message: "Profile Not Found" });
    }

    const row = await prisma.profile.findFirst({
      where: { username },
      select: {
        id: true,
        username: true,
        fullName: true,
        displayName: true,
        nickname: true,
        bio: true,
        profilePic: true,
        coverPic: true,
        isVerified: true,
        isOfficial: true,
        createdAt: true,
        userDoc: { select: { firstName: true, surname: true } },
      },
    });
    if (!row) return res.status(404).json({ message: "Profile Not Found" });

    const setting = await prisma.setting.findFirst({
      where: { profile: row.id },
      select: { postVisibility: true },
    });
    const indexable = (setting?.postVisibility || "public") === "public";

    res.set("Cache-Control", "public, max-age=300");
    if (!indexable) {
      return res.status(200).json({ username: row.username, indexable: false });
    }

    const name =
      row.fullName ||
      row.displayName ||
      [row.userDoc?.firstName, row.userDoc?.surname].filter(Boolean).join(" ") ||
      row.username;

    return res.status(200).json({
      indexable: true,
      username: row.username,
      name,
      nickname: row.nickname || "",
      bio: row.bio || "",
      profilePic: row.profilePic || "",
      coverPic: row.coverPic || "",
      isVerified: Boolean(row.isVerified),
      isOfficial: Boolean(row.isOfficial),
      joinedAt: row.createdAt,
    });
  } catch (error) {
    console.error("Error in publicProfileGet:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.profileGet = async function (req, res, next) {
  try {
    const profileId = req.query?.profileId || req.params?.profileId;
    const lite =
      req.query?.lite === "1" ||
      req.query?.lite === "true" ||
      req.query?.fields === "lite";

    if (!profileId) {
      return res.status(400).json({ message: "Profile ID is required" });
    }

    const profileData = await loadProfileDocument(profileId, {
      lite,
      includePrivateUserFields: isOwnProfileRequest(req, profileId),
    });
    if (!profileData) {
      return res.status(404).json({ message: "Profile Not Found" });
    }

    return res.status(200).json(profileData);
  } catch (error) {
    console.error("Error in profileGet:", error);
    return res.status(500).json({ message: "Internal server error" });
  }
};

exports.profilePost = async (req, res, next) => {
  try {
    const profileId = req.body.profile;
    if (!profileId) {
      return res.status(400).json({ message: "Profile ID is required" });
    }

    const lite = Boolean(req.body.lite);
    const profileData = await loadProfileDocument(profileId, {
      lite,
      includePrivateUserFields: isOwnProfileRequest(req, profileId),
    });
    if (!profileData) {
      return res.status(404).json({ message: "Profile Not Found" });
    }

    return res.status(200).json(profileData);
  } catch (error) {
    next(error);
  }
};
exports.updateCoverPost = async (req, res, next) => {
  let profileId = req.body.profile;
  let coverPicUrl = req.body.coverPicUrl;
  try {
  const previous = isValidId(profileId)
    ? await prisma.profile.findUnique({ where: { id: String(profileId) }, select: { id: true, coverPic: true } })
    : null
  // findOneAndUpdate without { new: true } answered with the document before the update.
  let updateProfile = previous ? await loadPlainProfile(profileId) : null;
  if (previous) {
    await prisma.profile.update({ where: { id: previous.id }, data: { coverPic: coverPicUrl } });
  }
    if (previous?.coverPic && previous.coverPic !== coverPicUrl) {
      await deleteCloudinaryResources([previous.coverPic]);
    }
    res.json(updateProfile);
  } catch (error) {
    console.log(error);
  }
};

exports.updateProfilePic = async (req, res, next) => {
  let profileId = req.profile._id;
  let profilePicUrl = req.body.profilePicUrl;
  let caption = req.body.caption;
  let type = req.body.type || "post";

  try {
    let savedPost = await prisma.post.create({
      data: {
        type,
        caption,
        photos: profilePicUrl,
        author: String(profileId),
      },
    });

    await prisma.profile.update({
      where: { id: String(profileId) },
      data: { profilePic: profilePicUrl },
    });
    let updatedProfile = await loadPlainProfile(profileId);

    if (savedPost && updatedProfile) {
      return res.json(updatedProfile);
    }
  } catch (error) {
    console.log(error);
  }
};

exports.updateBioPost = async (req, res, next) => {
  try {
    let bio = req.body.bio;
    await prisma.profile.update({
      where: { id: String(req.profile._id) },
      data: { bio },
    });
    let updateProfile = await loadPlainProfile(req.profile._id);

    if (updateProfile) {
      res.json(updateProfile);
    }
  } catch (error) {
    console.log(error);
  }
};
exports.updateProfile = async (req, res, next) => {
  try {
    let reqData = { ...req.body };

    if (Object.prototype.hasOwnProperty.call(req.body, "appMenuOrder")) {
      if (
        !Array.isArray(req.body.appMenuOrder) ||
        req.body.appMenuOrder.some(
          (item) => typeof item !== "string" || item.length > 100,
        )
      ) {
        return res.status(400).json({ message: "Invalid app menu order" });
      }
      reqData.appMenuOrder = [...new Set(req.body.appMenuOrder)];
    }

    if (req.body.firstName && req.body.surname) {
      reqData.fullName = req.body.firstName + " " + req.body.surname;

      await prisma.user.updateMany({
        where: { id: String(asId(req.profile.user) || req.profile.user) },
        data: {
          firstName: req.body.firstName,
          surname: req.body.surname,
        },
      });
    }

    await prisma.profile.update({
      where: { id: String(req.profile._id) },
      data: profileData(reqData),
    });
    let updateProfile = await loadOwnProfile(req.profile._id);

    if (updateProfile) {
      res.json(updateProfile);
    }
  } catch (error) {
    console.log(error);
  }
};

// Update Bengali name
exports.updateBanglaName = async (req, res, next) => {
  try {
    const profileId = req.profile._id;
    const { banglaName } = req.body;

    if (!banglaName || banglaName.trim().length === 0) {
      return res.status(400).json({ message: "Bengali name cannot be empty" });
    }

    const exists = await prisma.profile.updateMany({
      where: { id: String(profileId) },
      data: { banglaName: banglaName.trim() },
    });
    const updatedProfile = exists.count ? await loadOwnProfile(profileId) : null;

    if (updatedProfile) {
      return res.status(200).json({
        success: true,
        message: "Bengali name updated successfully",
        profile: updatedProfile,
      });
    }

    return res.status(404).json({ message: "Profile not found" });
  } catch (error) {
    console.error("Error updating Bengali name:", error);
    return res.status(500).json({
      message: "Failed to update Bengali name",
      error: error.message,
    });
  }
};

// Get nearby profiles based on location
exports.getNearbyProfiles = async (req, res, next) => {
  try {
    const { latitude, longitude, radius = 50, profileId } = req.query;

    // Validate required parameters
    if (!latitude || !longitude) {
      return res.status(400).json({
        message: "Latitude and longitude are required",
      });
    }

    const userLat = parseFloat(latitude);
    const userLng = parseFloat(longitude);
    const maxRadius = parseFloat(radius); // in kilometers

    if (isNaN(userLat) || isNaN(userLng) || isNaN(maxRadius)) {
      return res.status(400).json({
        message: "Invalid latitude, longitude, or radius values",
      });
    }

    // Get current user's connects list if profileId is provided
    let userConnects = [];
    if (profileId) {
      try {
        if (isValidId(profileId)) {
          userConnects = (await graphIds.connects(profileId)).map((fid) => String(fid));
        }
      } catch (err) {
        console.warn("Error fetching current user connects:", err);
      }
    }

    // Find all profiles with valid locations
    // lastLocation is a Json column: load the rows that have one and keep
    // those with non-zero numeric coordinates.
    const allProfiles = (
      await prisma.profile.findMany({
        where: { lastLocation: { not: Prisma.AnyNull } },
        select: { id: true, fullName: true, displayName: true, profilePic: true, username: true, bio: true, lastLocation: true },
      })
    ).filter((p) => {
      const loc = p.lastLocation;
      return loc && loc.latitude != null && loc.latitude !== 0 && loc.longitude != null && loc.longitude !== 0;
    });

    // Calculate distance for each profile and filter by radius
    const nearbyProfiles = [];

    for (const profile of allProfiles) {
      // Skip current user if profileId is provided
      if (profileId && String(profile._id) === String(profileId)) {
        continue;
      }

      const profileLat = profile.lastLocation.latitude;
      const profileLng = profile.lastLocation.longitude;

      // Calculate distance using Haversine formula
      const R = 6371; // Earth's radius in km
      const dLat = ((profileLat - userLat) * Math.PI) / 180;
      const dLng = ((profileLng - userLng) * Math.PI) / 180;
      const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos((userLat * Math.PI) / 180) *
          Math.cos((profileLat * Math.PI) / 180) *
          Math.sin(dLng / 2) *
          Math.sin(dLng / 2);
      const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
      const distance = R * c;

      // Only include profiles within the radius
      if (distance <= maxRadius) {
        const profileIdStr = String(profile._id);
        nearbyProfiles.push({
          _id: profile._id,
          fullName: profile.fullName || profile.displayName || "User",
          displayName: profile.displayName,
          profilePic: profile.profilePic,
          username: profile.username,
          bio: profile.bio,
          lastLocation: {
            latitude: profileLat,
            longitude: profileLng,
            timestamp: profile.lastLocation.timestamp,
          },
          distance: parseFloat(distance.toFixed(2)),
          isConnect: userConnects.includes(profileIdStr),
        });
      }
    }

    // Sort by distance (nearest first)
    nearbyProfiles.sort((a, b) => a.distance - b.distance);

    console.log(
      `📍 Found ${nearbyProfiles.length} nearby profiles within ${maxRadius}km`,
    );

    return res.status(200).json({
      success: true,
      count: nearbyProfiles.length,
      profiles: nearbyProfiles,
    });
  } catch (error) {
    console.error("Error in getNearbyProfiles:", error);
    return res.status(500).json({
      message: "Internal server error",
      error: error.message,
    });
  }
};

// HTTP-based online status checking
exports.getOnlineStatus = async (req, res, next) => {
  try {
    const { profileId, profileIds } = req.query;
    const rawIds = [];

    if (profileIds) {
      const parsed = Array.isArray(profileIds)
        ? profileIds
        : String(profileIds).split(",");
      rawIds.push(...parsed);
    }
    if (profileId) {
      rawIds.push(profileId);
    }

    const uniqueIds = [
      ...new Set(rawIds.map((id) => String(id || "").trim()).filter(isMongoId)),
    ];

    if (uniqueIds.length === 0) {
      return res.status(400).json({ isActive: false, lastSeen: null, statuses: {} });
    }

    const profiles = await prisma.profile.findMany({
      where: { id: { in: uniqueIds } },
      select: { id: true, isActive: true, lastActive: true },
    });

    const statuses = {};
    profiles.forEach((profile) => {
      const lastSeen = profile.lastActive ? new Date(profile.lastActive) : null;
      statuses[String(profile._id)] = {
        isActive: computeIsActive(profile),
        lastSeen,
      };
    });

    uniqueIds.forEach((id) => {
      if (!statuses[id]) {
        statuses[id] = { isActive: false, lastSeen: null };
      }
    });

    if (uniqueIds.length === 1) {
      return res.status(200).json({
        ...statuses[uniqueIds[0]],
        statuses,
      });
    }

    return res.status(200).json({ statuses });
  } catch (error) {
    console.error("Error checking online status:", error);
    return res.status(500).json({ isActive: false, lastSeen: null, statuses: {} });
  }
};

exports.getNearbyPlaces = async (req, res, next) => {
  try {
    const { latitude, longitude, radius = 2000 } = req.query;

    // Validate required parameters
    if (!latitude || !longitude) {
      return res.status(400).json({
        message: "Latitude and longitude are required",
      });
    }

    const lat = parseFloat(latitude);
    const lng = parseFloat(longitude);
    const rad = parseInt(radius);

    // Validate coordinates
    if (
      isNaN(lat) ||
      isNaN(lng) ||
      lat < -90 ||
      lat > 90 ||
      lng < -180 ||
      lng > 180
    ) {
      return res.status(400).json({
        message: "Invalid latitude or longitude values",
      });
    }

    const PLACE_TYPES = ["restaurant", "cafe", "park"];
    const mapPlaceTypeToOverpassTag = (type) => {
      switch (type) {
        case "restaurant":
          return '["amenity"="restaurant"]';
        case "cafe":
          return '["amenity"="cafe"]';
        case "park":
          return '["leisure"="park"]';
        default:
          return "";
      }
    };

    const aroundClauses = PLACE_TYPES.map((type) => {
      const tag = mapPlaceTypeToOverpassTag(type);
      return `
                node${tag}(around:${rad},${lat},${lng});
                way${tag}(around:${rad},${lat},${lng});
                relation${tag}(around:${rad},${lat},${lng});
            `;
    }).join("\n");

    const query = `
            [out:json][timeout:15];
            (
                ${aroundClauses}
            );
            out center tags;
        `;

    const overpassEndpoints = [
      "https://overpass-api.de/api/interpreter",
      "https://overpass.kumi.systems/api/interpreter",
    ];

    const requestBody = new URLSearchParams({ data: query }).toString();
    const fetchWithTimeout = async (url, options, timeoutMs = 20000) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
      try {
        return await fetch(url, { ...options, signal: controller.signal });
      } finally {
        clearTimeout(timeoutId);
      }
    };

    let data = null;
    let lastError = null;

    for (const endpoint of overpassEndpoints) {
      try {
        const response = await fetchWithTimeout(
          endpoint,
          {
            method: "POST",
            headers: {
              "Content-Type":
                "application/x-www-form-urlencoded; charset=UTF-8",
              Accept: "application/json",
              "User-Agent": "connect-app/1.0 (nearby-places)",
            },
            body: requestBody,
          },
          20000,
        );

        if (!response.ok) {
          const errorBody = await response.text().catch(() => "");
          lastError = new Error(
            `Overpass API request failed (${endpoint}) with status ${response.status}${errorBody ? `: ${errorBody.slice(0, 200)}` : ""}`,
          );
          continue;
        }

        data = await response.json();
        break;
      } catch (requestError) {
        lastError = requestError;
      }
    }

    if (!data) {
      throw lastError || new Error("All Overpass API endpoints failed");
    }
    const seenPlaceIds = new Set();
    const places = [];

    (data.elements || []).forEach((place) => {
      const placeLat = place.lat ?? place.center?.lat;
      const placeLng = place.lon ?? place.center?.lon;
      if (typeof placeLat !== "number" || typeof placeLng !== "number") return;

      const placeKey = `${place.type}-${place.id}`;
      if (seenPlaceIds.has(placeKey)) return;
      seenPlaceIds.add(placeKey);

      const name = place.tags?.name || place.tags?.brand || "Place";
      const address = [
        place.tags?.["addr:housenumber"],
        place.tags?.["addr:street"],
      ]
        .filter(Boolean)
        .join(" ");
      const category =
        place.tags?.amenity || place.tags?.leisure || place.tags?.tourism || "";

      places.push({
        id: place.id,
        type: place.type,
        lat: placeLat,
        lng: placeLng,
        name,
        address,
        category,
      });
    });

    return res.status(200).json({
      success: true,
      places,
      count: places.length,
    });
  } catch (error) {
    console.error("Error fetching nearby places:", error);
    return res.status(500).json({
      message: "Failed to fetch nearby places",
      error: error.message,
    });
  }
};

const parseTargetProfileId = (req) =>
  asId(
    req.body?.profileId ||
      req.body?.profile ||
      req.query?.profileId ||
      req.query?.profile,
  );

exports.followProfile = async (req, res, next) => {
  try {
    const myId = asId(req.profile?._id);
    const targetId = parseTargetProfileId(req);
    if (!myId) return res.status(401).json({ message: "Unauthorized" });
    if (!targetId) return res.status(400).json({ message: "Invalid profile id" });
    if (targetId === myId) {
      return res.status(400).json({ message: "Cannot follow yourself" });
    }

    const target = await prisma.profile.findUnique({ where: { id: targetId }, select: { id: true, fullName: true } });
    if (!target) return res.status(404).json({ message: "Profile not found" });

    const me = await prisma.profile.findUnique({
      where: { id: myId },
      select: { id: true, fullName: true, profilePic: true },
    });

    if (!me) return res.status(401).json({ message: "Unauthorized" });

    // One Follow row replaces both following/followers $addToSet writes.
    await prisma.follow.createMany({
      data: [{ follower: myId, following: targetId }],
      skipDuplicates: true,
    });
    me.following = await graphIds.following(myId);

    const io = req.app.get("io");
    if (io && typeof io.to === "function") {
      try {
        await saveNotification(io, {
          receiverId: targetId,
          text: `${me.fullName || "Someone"} started following you`,
          link: `/${myId}`,
          icon: me.profilePic,
          type: "follow",
          data: { senderId: myId, senderName: me.fullName },
        });
      } catch (_e) {}
      try {
        await sendPushToProfile(targetId, {
          title: "New follower",
          body: `${me.fullName || "Someone"} started following you`,
          data: { type: "follow", senderId: myId },
        });
      } catch (_e) {}
    }

    return res.status(200).json({
      following: true,
      followingIds: me.following || [],
    });
  } catch (error) {
    next(error);
  }
};

exports.unfollowProfile = async (req, res, next) => {
  try {
    const myId = asId(req.profile?._id);
    const targetId = parseTargetProfileId(req);
    if (!myId) return res.status(401).json({ message: "Unauthorized" });
    if (!targetId) return res.status(400).json({ message: "Invalid profile id" });

    await prisma.follow.deleteMany({ where: { follower: myId, following: targetId } });
    const meExists = await prisma.profile.findUnique({ where: { id: myId }, select: { id: true } });
    const me = meExists ? { following: await graphIds.following(myId) } : null;

    return res.status(200).json({
      following: false,
      followingIds: me?.following || [],
    });
  } catch (error) {
    next(error);
  }
};

exports.getFollowStatus = async (req, res, next) => {
  try {
    const myId = asId(req.profile?._id);
    const targetId = parseTargetProfileId(req);
    if (!myId) return res.status(401).json({ message: "Unauthorized" });
    if (!targetId) return res.status(400).json({ message: "Invalid profile id" });

    const meExists = await prisma.profile.findUnique({ where: { id: myId }, select: { id: true } });
    const me = meExists ? { following: await graphIds.following(myId) } : null;

    return res.status(200).json({
      following: listHasId(me?.following, targetId),
      followingIds: me?.following || [],
    });
  } catch (error) {
    next(error);
  }
};
