const { Prisma, prisma, pluck } = require('./db')
const { deleteCloudinaryResources } = require('./cloudinaryCleanup')
const { deleteSecureContent } = require('./secureMessages')

/**
 * Removes a profile, its user and every row that belongs to them, including
 * the social-graph join tables and the reacts/shares/views on content they
 * authored (relationMode = "prisma" means nothing cascades in the database).
 */
const deleteUserData = async (profileId) => {
    profileId = String(profileId)
    const sid = { select: { id: true } }

    const [profile, stories, posts, watches, messages, comments, replies, settings] = await Promise.all([
        prisma.profile.findUnique({ where: { id: profileId }, select: { id: true, user: true, profilePic: true, coverPic: true } }),
        prisma.story.findMany({ where: { author: profileId }, select: { id: true, image: true, music: true } }),
        prisma.post.findMany({ where: { author: profileId }, select: { id: true, photos: true } }),
        prisma.watch.findMany({ where: { author: profileId }, select: { id: true, videoUrl: true, thumbnail: true } }),
        prisma.message.findMany({ where: { OR: [{ senderId: profileId }, { receiverId: profileId }] }, select: { id: true, attachment: true } }),
        prisma.comment.findMany({ where: { author: profileId }, select: { id: true, attachment: true } }),
        prisma.cmntReply.findMany({ where: { author: profileId }, select: { id: true, attachment: true } }),
        prisma.setting.findFirst({ where: { profile: profileId }, select: { id: true, chatBackground: true } }),
    ])

    const userIds = (await prisma.user.findMany({ where: { profile: profileId }, ...sid })).map((u) => u.id)
    if (profile?.user) userIds.push(profile.user)

    const postIds = pluck(posts, 'id')
    const watchIds = pluck(watches, 'id')
    const storyIds = pluck(stories, 'id')
    const commentIds = (await prisma.comment.findMany({
        where: { OR: [{ author: profileId }, { post: { in: postIds } }, { watch: { in: watchIds } }, { story: { in: storyIds } }] },
        ...sid,
    })).map((c) => c.id)

    const own = { profile: profileId }
    const byUser = { user: profileId }
    const byUserId = { userId: { in: userIds } }

    await prisma.$transaction([
        // Content they authored, and everything hanging off it
        prisma.postMention.deleteMany({ where: { OR: [own, { post: { in: postIds } }] } }),
        prisma.postReact.deleteMany({ where: { OR: [own, { post: { in: postIds } }] } }),
        prisma.postShare.deleteMany({ where: { OR: [own, { post: { in: postIds } }] } }),
        prisma.postViewer.deleteMany({ where: { OR: [own, { post: { in: postIds } }] } }),
        prisma.watchReact.deleteMany({ where: { OR: [own, { watch: { in: watchIds } }] } }),
        prisma.watchShare.deleteMany({ where: { OR: [own, { watch: { in: watchIds } }] } }),
        prisma.storyReact.deleteMany({ where: { OR: [own, { story: { in: storyIds } }] } }),
        prisma.storySeen.deleteMany({ where: { OR: [own, { story: { in: storyIds } }] } }),
        prisma.cmntReply.deleteMany({ where: { OR: [{ author: profileId }, { parent: { in: commentIds } }, { post: { in: postIds } }] } }),
        prisma.comment.deleteMany({ where: { id: { in: commentIds } } }),
        prisma.report.deleteMany({ where: { OR: [{ reportedBy: profileId }, { targetProfile: profileId }, { targetPost: { in: postIds } }] } }),
        prisma.aIGeneratedPost.deleteMany({ where: { OR: [{ author: profileId }, { post: { in: postIds } }] } }),
        // Raw DELETEs for rows other rows may still point at (a share of their
        // post, the User row's profile ref): relationMode "prisma" emulates
        // NoAction as restrict, while Mongo left those references dangling.
        prisma.$executeRaw`DELETE FROM posts WHERE author = ${profileId}`,
        prisma.$executeRaw`DELETE FROM watches WHERE author = ${profileId}`,
        prisma.$executeRaw`DELETE FROM stories WHERE author = ${profileId}`,
        prisma.message.deleteMany({ where: { OR: [{ senderId: profileId }, { receiverId: profileId }] } }),
        prisma.notification.deleteMany({ where: { receiverId: profileId } }),

        // Social graph
        prisma.profileConnect.deleteMany({ where: { OR: [own, { connect: profileId }] } }),
        prisma.connectRequest.deleteMany({ where: { OR: [own, { requester: profileId }] } }),
        prisma.follow.deleteMany({ where: { OR: [{ follower: profileId }, { following: profileId }] } }),
        prisma.block.deleteMany({ where: { OR: [own, { blocked: profileId }] } }),
        prisma.relationship.deleteMany({ where: { OR: [{ userA: profileId }, { userB: profileId }, { createdBy: profileId }] } }),

        // Per-profile settings and tools
        prisma.setting.deleteMany({ where: own }),
        prisma.faceEncoding.deleteMany({ where: own }),
        prisma.userInterestProfile.deleteMany({ where: own }),
        prisma.aIChat.deleteMany({ where: byUser }),
        prisma.calendarEvent.deleteMany({ where: byUser }),
        prisma.flashcard.deleteMany({ where: byUser }),
        prisma.habit.deleteMany({ where: byUser }),
        prisma.note.deleteMany({ where: byUser }),
        prisma.task.deleteMany({ where: byUser }),
        prisma.timerSession.deleteMany({ where: byUser }),
        prisma.reminder.deleteMany({ where: byUser }),
        prisma.fitnessProfile.deleteMany({ where: byUser }),
        prisma.fitnessDailyLog.deleteMany({ where: byUser }),
        prisma.meal.deleteMany({ where: byUser }),
        prisma.weightLog.deleteMany({ where: byUser }),
        prisma.workoutLog.deleteMany({ where: byUser }),
        prisma.recoveryProfile.deleteMany({ where: byUser }),
        prisma.recoveryCheckIn.deleteMany({ where: byUser }),
        prisma.recoveryCraving.deleteMany({ where: byUser }),
        prisma.recoveryLapse.deleteMany({ where: byUser }),
        prisma.recoveryChatMessage.deleteMany({ where: byUser }),
        prisma.ludoGame.deleteMany({ where: { host: profileId } }),

        // Rows keyed by the User id
        prisma.savedVideo.deleteMany({ where: byUserId }),
        prisma.videoPlaylist.deleteMany({ where: byUserId }),
        prisma.coinReward.deleteMany({ where: byUserId }),
        prisma.coachingPurchase.deleteMany({ where: byUserId }),
        prisma.payoutRequest.deleteMany({ where: byUserId }),
        prisma.transaction.deleteMany({ where: byUserId }),
        prisma.tip.deleteMany({ where: { OR: [{ senderId: { in: userIds } }, { creatorId: { in: userIds } }] } }),

        prisma.$executeRaw`DELETE FROM profiles WHERE id = ${profileId}`,
        ...(userIds.length ? [prisma.$executeRaw`DELETE FROM users WHERE id IN (${Prisma.join(userIds)})`] : []),
    ])

    await deleteCloudinaryResources([
        profile?.profilePic,
        profile?.coverPic,
        ...stories.flatMap((story) => [story.image, story.music]),
        ...posts.map((post) => post.photos),
        ...watches.flatMap((watch) => [watch.videoUrl, watch.thumbnail]),
        ...messages.map((message) => message.attachment),
        ...comments.map((comment) => comment.attachment),
        ...replies.map((reply) => reply.attachment),
        settings?.chatBackground,
    ])
    // Encrypted secure-message content lives in its own table.
    await deleteSecureContent(messages.map((message) => message.id))
}

module.exports = deleteUserData
