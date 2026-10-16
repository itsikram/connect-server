const { prisma } = require("../utils/db");
const { graphIds } = require("../utils/profileGraph");

exports.getDigest = async (req, res, next) => {
  try {
    const profileId = req.profile?._id;
    if (!profileId) {
      return res.status(401).json({ message: "Unauthorized" });
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const soon = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);

    const me = String(profileId);
    const [connectsList, pendingConnectReqs] = await Promise.all([
      graphIds.connects(me),
      prisma.connectRequest.count({ where: { profile: me } }),
    ]);

    const myPosts = await prisma.post.findMany({
      where: { author: me, createdAt: { gte: weekAgo } },
      select: {
        id: true,
        caption: true,
        createdAt: true,
        _count: { select: { reacts: true, comments: true } },
      },
    });

    const reactsReceived = myPosts.reduce((n, post) => n + post._count.reacts, 0);
    const commentsReceived = myPosts.reduce((n, post) => n + post._count.comments, 0);

    const [notesThisWeek, upcomingEvents, topConnectPost] = await Promise.all([
      prisma.note.count({
        where: { user: me, updatedAt: { gte: weekAgo } },
      }),
      prisma.calendarEvent.findMany({
        where: { user: me, date: { gte: new Date(), lte: soon } },
        orderBy: { date: "asc" },
        take: 5,
        select: { id: true, title: true, date: true, time: true },
      }),
      connectsList.length
        ? prisma.post.findFirst({
            where: {
              author: { in: connectsList },
              audience: { in: [1, 2] },
              createdAt: { gte: weekAgo },
            },
            orderBy: { createdAt: "desc" },
            select: { id: true, caption: true, author: true, createdAt: true },
          })
        : null,
    ]);

    return res.status(200).json({
      postsThisWeek: myPosts.length,
      reactsReceived,
      commentsReceived,
      connectCount: connectsList.length,
      pendingConnectReqs,
      notesThisWeek,
      upcomingEvents,
      topConnectPost,
    });
  } catch (error) {
    next(error);
  }
};
