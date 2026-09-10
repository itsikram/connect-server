const Post = require("../models/Post");
const Profile = require("../models/Profile");
const Note = require("../models/Note");
const CalendarEvent = require("../models/CalendarEvent");

exports.getDigest = async (req, res, next) => {
  try {
    const profileId = req.profile?._id;
    if (!profileId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const currentProfile = await Profile.findById(profileId).select(
      "connects connectReqs",
    );
    const connectsList = currentProfile?.connects || [];

    const myPosts = await Post.find({
      author: profileId,
      createdAt: { $gte: weekAgo },
    }).select("reacts comments caption createdAt");

    const reactsReceived = myPosts.reduce(
      (n, post) => n + (Array.isArray(post.reacts) ? post.reacts.length : 0),
      0,
    );
    const commentsReceived = myPosts.reduce(
      (n, post) => n + (Array.isArray(post.comments) ? post.comments.length : 0),
      0,
    );

    const [notesThisWeek, upcomingEvents, topConnectPost] = await Promise.all([
      Note.countDocuments({
        user: profileId,
        updatedAt: { $gte: weekAgo },
      }),
      CalendarEvent.find({
        user: profileId,
        date: { $gte: new Date(), $lte: soon },
      })
        .sort({ date: 1 })
        .limit(5)
        .select("title date time"),
      connectsList.length
        ? Post.findOne({
            author: { $in: connectsList },
            audience: { $in: [1, 2] },
            createdAt: { $gte: weekAgo },
          })
            .sort({ createdAt: -1 })
            .select("caption author createdAt")
        : null,
    ]);

    return res.status(200).json({
      postsThisWeek: myPosts.length,
      reactsReceived,
      commentsReceived,
      connectCount: connectsList.length,
      pendingConnectReqs: currentProfile?.connectReqs?.length || 0,
      notesThisWeek,
      upcomingEvents,
      topConnectPost,
    });
  } catch (error) {
    next(error);
  }
};
