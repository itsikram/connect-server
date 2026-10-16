const { prisma, populated, containsInsensitive } = require("../utils/db");
const { PRIVATE_OMIT } = require("../utils/profileGraph");
const { postInclude, watchInclude, shapePost, shapeWatch } = require("../services/contentShape");
const {
  getSearchMatchScore,
  getSearchTokens,
} = require("../utils/searchMatching");

exports.getSearchResult = async (req, res, next) => {
  try {
    const queryString = String(req.query.input || "").trim();

    let searchResponse = {
      posts: null,
      users: null,
      videos: null,
    };

    const nameFields = ["fullName", "banglaName", "displayName", "nickname", "username"];
    let usersFound = await prisma.profile.findMany({
      where: { OR: nameFields.map((field) => ({ [field]: containsInsensitive(queryString) })) },
      select: {
        id: true,
        fullName: true,
        displayName: true,
        username: true,
        nickname: true,
        banglaName: true,
        profilePic: true,
        bio: true,
        user: true,
        userDoc: { select: { id: true, firstName: true, surname: true, username: true } },
      },
      take: 25,
    });
    usersFound = populated(usersFound, "user");

    if (usersFound) {
      searchResponse.users = usersFound;
    }

    const authorArgs = { omit: PRIVATE_OMIT };
    let postsFound = (
      await prisma.post.findMany({
        where: { caption: containsInsensitive(queryString) },
        include: postInclude({ author: authorArgs }),
        take: 25,
      })
    ).map(shapePost);

    if (postsFound) {
      searchResponse.posts = postsFound;
    }
    const videoTokens = getSearchTokens(queryString);
    const findVideos = (args) =>
      prisma.watch
        .findMany({ ...args, include: watchInclude({ author: authorArgs }), take: 100 })
        .then((rows) => rows.map(shapeWatch));
    let videoCandidates = videoTokens.length
      ? await findVideos({
          where: { OR: videoTokens.map((token) => ({ caption: containsInsensitive(token) })) },
        })
      : [];

    // If every token was misspelled, compare against a bounded recent set
    // rather than returning no result immediately.
    if (videoCandidates.length === 0 && videoTokens.length > 0) {
      videoCandidates = await findVideos({ orderBy: { createdAt: "desc" } });
    }

    const videosFound = videoCandidates
      .map((video) => ({
        video,
        score: getSearchMatchScore(queryString, video.caption),
      }))
      .filter(({ score }) => score >= 0.55)
      .sort((left, right) => right.score - left.score)
      .slice(0, 20)
      .map(({ video }) => video);

    searchResponse.videos = videosFound;

    if (usersFound || postsFound || videosFound) {
      return res.status(200).json(searchResponse);
    }

    return res.status(400).json({ message: "No search results found" });
  } catch (e) {
    next(e);
  }
};
