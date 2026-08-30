const Profile = require("../models/Profile");
const Post = require("../models/Post");
const Story = require("../models/Story");
const mongoose = require("mongoose");
const User = require("../models/User");

const MONGO_ID_RE = /^[a-fA-F0-9]{24}$/;
const ONLINE_WINDOW_MS = 5 * 60 * 1000;
const PROFILE_PRIVATE_EXCLUDE =
  "-deviceTokens -browserIds -webPushSubscriptions";
const FRIEND_PUBLIC_FIELDS =
  "_id fullName displayName username nickname profilePic bio isActive lastActive lastLocation user";
const USER_PUBLIC_FIELDS = "firstName surname";
const LITE_PROFILE_FIELDS =
  "_id fullName displayName username nickname profilePic coverPic bio isActive lastActive lastLocation blockedUsers friends friendReqs user";

const isMongoId = (value) => MONGO_ID_RE.test(String(value || ""));

const computeIsActive = (profile) => {
  if (!profile) return false;
  if (profile.isActive) return true;
  const lastActive = profile.lastActive
    ? new Date(profile.lastActive).getTime()
    : 0;
  return Boolean(lastActive && Date.now() - lastActive < ONLINE_WINDOW_MS);
};

const loadProfileDocument = async (profileId, { lite = false } = {}) => {
  if (!profileId) return null;

  const query = isMongoId(profileId)
    ? { _id: profileId }
    : { username: profileId };

  const findQuery = Profile.findOne(query);

  if (lite) {
    findQuery.select(LITE_PROFILE_FIELDS).populate({
      path: "user",
      select: USER_PUBLIC_FIELDS,
    });
  } else {
    findQuery
      .select(PROFILE_PRIVATE_EXCLUDE)
      .populate({
        path: "friends",
        select: FRIEND_PUBLIC_FIELDS,
        populate: { path: "user", select: USER_PUBLIC_FIELDS },
      })
      .populate({
        path: "user",
        select: USER_PUBLIC_FIELDS,
      });
  }

  return findQuery;
};

exports.prefileHasStory = async function (req, res, next) {
  try {
    const twentyFourHoursAgo = new Date();
    twentyFourHoursAgo.setHours(twentyFourHoursAgo.getHours() - 24);
    let profileId = req.query.profileId;
    
    if (!profileId) {
      return res.status(400).json({ message: "profileId is required", hasStory: "no" });
    }
    
    if (mongoose.isValidObjectId(profileId)) {
      let hasStory = await Story.exists({
        author: profileId,
        createdAt: { $gte: twentyFourHoursAgo },
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
    if (!mongoose.isValidObjectId(profileId)) return;
    let profileImages = await Post.find({
      author: profileId,
      photos: {
        $ne: "null",
      },
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

    const profileData = await loadProfileDocument(profileId, { lite });
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
    const profileData = await loadProfileDocument(profileId, { lite });
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
    let updateProfile = await Profile.findOneAndUpdate(
      { _id: profileId },
      {
        coverPic: coverPicUrl,
      },
    );
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
    let post = new Post({
      type,
      caption,
      photos: profilePicUrl,
      author: profileId,
    });

    let savedPost = await post.save();

    let updatedProfile = await Profile.findByIdAndUpdate(
      { _id: profileId },
      {
        profilePic: profilePicUrl,
      },
      { new: true },
    );

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
    let updateProfile = await Profile.findByIdAndUpdate(
      {
        _id: req.profile._id,
      },
      {
        bio,
      },
      { new: true },
    );

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

    if (req.body.firstName && req.body.surname) {
      reqData.fullName = req.body.firstName + " " + req.body.surname;

      let updatedUser = await User.findOneAndUpdate(
        { _id: req.profile.user },
        {
          firstName: req.body.firstName,
          surname: req.body.surname,
        },
        { new: true },
      );
    }

    let updateProfile = await Profile.findByIdAndUpdate(
      {
        _id: req.profile._id,
      },
      {
        ...reqData,
      },
      { new: true },
    ).populate("user");

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

    const updatedProfile = await Profile.findByIdAndUpdate(
      { _id: profileId },
      { banglaName: banglaName.trim() },
      { new: true },
    ).populate("user");

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

    // Get current user's friends list if profileId is provided
    let userFriends = [];
    if (profileId) {
      try {
        const currentUser = await Profile.findById(profileId).select("friends");
        if (currentUser && currentUser.friends) {
          userFriends = currentUser.friends.map((fid) => String(fid));
        }
      } catch (err) {
        console.warn("Error fetching current user friends:", err);
      }
    }

    // Find all profiles with valid locations
    const allProfiles = await Profile.find({
      "lastLocation.latitude": { $exists: true, $ne: null, $ne: 0 },
      "lastLocation.longitude": { $exists: true, $ne: null, $ne: 0 },
    }).select("_id fullName displayName profilePic username bio lastLocation");

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
          isFriend: userFriends.includes(profileIdStr),
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

    const profiles = await Profile.find({ _id: { $in: uniqueIds } })
      .select("_id isActive lastActive")
      .lean();

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
