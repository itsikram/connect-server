// Social-graph helpers for profile payloads. The Mongo Profile document held
// connects / connectReqs / following / followers / blockedUsers arrays; they
// are now the ProfileConnect, ConnectRequest, Follow and Block tables. These
// helpers rebuild the old array shape (plus the followersCount /
// followingCount virtuals) so API responses stay the same.
const { prisma, populated, pluck, isValidId } = require("./db");

const PRIVATE_OMIT = { deviceTokens: true, browserIds: true, webPushSubscriptions: true };

const USER_PUBLIC_SELECT = { id: true, firstName: true, surname: true };
const USER_OWN_SELECT = { id: true, firstName: true, surname: true, email: true, faceLoginEnabled: true };

const CONNECT_PUBLIC_SELECT = {
  id: true,
  fullName: true,
  displayName: true,
  username: true,
  nickname: true,
  profilePic: true,
  bio: true,
  isOfficial: true,
  isVerified: true,
  isActive: true,
  lastActive: true,
  lastLocation: true,
  user: true,
};

/** Include block that loads the five graph arrays as id rows. */
const GRAPH_INCLUDE = {
  connects: { select: { connect: true }, orderBy: { createdAt: "asc" } },
  connectReqs: { select: { requester: true }, orderBy: { createdAt: "asc" } },
  following: { select: { following: true }, orderBy: { createdAt: "asc" } },
  followers: { select: { follower: true }, orderBy: { createdAt: "asc" } },
  blockedUsers: { select: { blocked: true }, orderBy: { createdAt: "asc" } },
};

/**
 * Turn the join rows loaded with GRAPH_INCLUDE back into id arrays, add the
 * follower counters and move userDoc onto `user`. Rows from connects with a
 * `connectDoc` become populated profile objects.
 */
function shapeProfile(row) {
  if (!row || typeof row !== "object") return row;
  populated(row, "user");
  if (Array.isArray(row.connects)) {
    row.connects = row.connects
      .map((c) => (c.connectDoc !== undefined ? populated(c.connectDoc, "user") : c.connect))
      .filter((v) => v != null);
  }
  if (Array.isArray(row.connectReqs)) row.connectReqs = pluck(row.connectReqs, "requester");
  if (Array.isArray(row.following)) row.following = pluck(row.following, "following");
  if (Array.isArray(row.followers)) row.followers = pluck(row.followers, "follower");
  if (Array.isArray(row.blockedUsers)) row.blockedUsers = pluck(row.blockedUsers, "blocked");
  if (Array.isArray(row.followers) || Array.isArray(row.following)) {
    row.followersCount = Array.isArray(row.followers) ? row.followers.length : 0;
    row.followingCount = Array.isArray(row.following) ? row.following.length : 0;
  }
  return row;
}

/** Profile lookup by id or username, the way the old Profile.findOne(query) did. */
const profileWhere = (profileIdOrUsername) =>
  isValidId(profileIdOrUsername)
    ? { id: String(profileIdOrUsername) }
    : { username: String(profileIdOrUsername) };

/** Full profile (private push fields omitted) with graph arrays and user. */
async function findProfileWithGraph(where, { userSelect = USER_PUBLIC_SELECT, populateConnects = false } = {}) {
  const include = { ...GRAPH_INCLUDE, userDoc: { select: userSelect } };
  if (populateConnects) {
    include.connects = {
      select: {
        connect: true,
        connectDoc: { select: { ...CONNECT_PUBLIC_SELECT, userDoc: { select: USER_PUBLIC_SELECT } } },
      },
      orderBy: { createdAt: "asc" },
    };
  }
  const row = await prisma.profile.findFirst({ where, omit: PRIVATE_OMIT, include });
  return shapeProfile(row);
}

/** Id arrays of one graph edge for a profile. */
const graphIds = {
  connects: async (id) =>
    pluck(await prisma.profileConnect.findMany({ where: { profile: String(id) }, select: { connect: true }, orderBy: { createdAt: "asc" } }), "connect"),
  connectReqs: async (id) =>
    pluck(await prisma.connectRequest.findMany({ where: { profile: String(id) }, select: { requester: true }, orderBy: { createdAt: "asc" } }), "requester"),
  following: async (id) =>
    pluck(await prisma.follow.findMany({ where: { follower: String(id) }, select: { following: true }, orderBy: { createdAt: "asc" } }), "following"),
  followers: async (id) =>
    pluck(await prisma.follow.findMany({ where: { following: String(id) }, select: { follower: true }, orderBy: { createdAt: "asc" } }), "follower"),
  blockedUsers: async (id) =>
    pluck(await prisma.block.findMany({ where: { profile: String(id) }, select: { blocked: true }, orderBy: { createdAt: "asc" } }), "blocked"),
};

module.exports = {
  PRIVATE_OMIT,
  USER_PUBLIC_SELECT,
  USER_OWN_SELECT,
  CONNECT_PUBLIC_SELECT,
  GRAPH_INCLUDE,
  shapeProfile,
  profileWhere,
  findProfileWithGraph,
  graphIds,
};
