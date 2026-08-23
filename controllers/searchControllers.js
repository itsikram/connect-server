const Profile = require("../models/Profile");
const Post = require("../models/Post");
const Watch = require("../models/Watch");
const {
  escapeRegex,
  getSearchMatchScore,
  getSearchTokens,
} = require("../utils/searchMatching");

exports.getSearchResult = async (req, res, next) => {
  try {
    const queryString = String(req.query.input || "").trim();
    const escapedQuery = escapeRegex(queryString);

    let searchResponse = {
      posts: null,
      users: null,
      videos: null,
    };

    let usersFound = await Profile.find({
      $or: [
        {
          fullName: {
            $regex: escapedQuery,
            $options: "i",
          },
        },
        {
          banglaName: {
            $regex: escapedQuery,
            $options: "i",
          },
        },
        {
          displayName: {
            $regex: escapedQuery,
            $options: "i",
          },
        },
        {
          nickname: {
            $regex: escapedQuery,
            $options: "i",
          },
        },
      ],
    });

    if (usersFound) {
      searchResponse.users = usersFound;
    }

    let postsFound = await Post.find({
      caption: {
        $regex: escapedQuery,
        $options: "i",
      },
    }).populate("author");

    if (postsFound) {
      searchResponse.posts = postsFound;
    }
    const videoTokens = getSearchTokens(queryString);
    const videoPattern = videoTokens.map(escapeRegex).join("|");
    let videoCandidates = videoPattern
      ? await Watch.find({
          caption: { $regex: videoPattern, $options: "i" },
        })
          .populate("author")
          .limit(100)
      : [];

    // If every token was misspelled, compare against a bounded recent set
    // rather than returning no result immediately.
    if (videoCandidates.length === 0 && videoTokens.length > 0) {
      videoCandidates = await Watch.find({})
        .sort({ createdAt: -1 })
        .populate("author")
        .limit(100);
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
