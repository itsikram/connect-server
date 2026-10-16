const { prisma, populated, isValidId, jsonObject, pickModelFields } = require('../utils/db')
const { rebuildInterestProfile, rebuildInterestProfiles } = require('../services/recommendationService')
const { GRAPH_INCLUDE, shapeProfile, CONNECT_PUBLIC_SELECT, USER_PUBLIC_SELECT } = require('../utils/profileGraph')
const {
    profileArgs,
    commentInclude,
    postInclude,
    watchInclude,
    storyInclude,
    shapePost,
    shapeWatch,
    shapeStory,
    deleteCommentsWhere,
    removeContent,
} = require('../services/contentShape')
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const SECRET_KEY = process.env.JWT_SECRET_KEY;
const deleteUserData = require('../utils/deleteUserData')
const sendEmailNotification = require('../utils/sendEmailNotification')
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup')

const getAdminAppUrl = () => {
    const url = (
        process.env.ADMIN_URL ||
        process.env.NEXT_PUBLIC_ADMIN_URL ||
        'http://localhost:5000'
    ).replace(/\/+$/, '');

    if (
        process.env.NODE_ENV === 'production' &&
        /localhost|127\.0\.0\.1/i.test(url)
    ) {
        console.warn(
            `ADMIN_URL is "${url}" in production. ` +
                'Set ADMIN_URL to your live admin URL in Render env vars.'
        );
    }

    return url;
};

// Never send password hashes / reset tokens in admin payloads.
const USER_SAFE = { omit: { password: true, resetPasswordToken: true, resetPasswordExpire: true } }

const findAdminByEmail = (email) => prisma.admin.findFirst({ where: { email } })

/** Admin profile payload: full profile, populated user and graph arrays (connects etc. as profile objects). */
const profileGraphInclude = (populate = []) => {
    const include = { ...GRAPH_INCLUDE, userDoc: USER_SAFE }
    const card = { select: { ...CONNECT_PUBLIC_SELECT, userDoc: { select: USER_PUBLIC_SELECT } } }
    if (populate.includes('connects')) include.connects = { select: { connect: true, connectDoc: card }, orderBy: { createdAt: 'asc' } }
    if (populate.includes('following')) include.following = { select: { following: true, followingDoc: card }, orderBy: { createdAt: 'asc' } }
    if (populate.includes('blockedUsers')) include.blockedUsers = { select: { blocked: true, blockedDoc: card }, orderBy: { createdAt: 'asc' } }
    return include
}

const shapeAdminProfile = (row) => {
    if (!row) return row
    if (Array.isArray(row.following) && row.following.some((f) => 'followingDoc' in f)) {
        row.following = row.following.map((f) => populated(f.followingDoc, 'user')).filter(Boolean)
    }
    if (Array.isArray(row.blockedUsers) && row.blockedUsers.some((b) => 'blockedDoc' in b)) {
        row.blockedUsers = row.blockedUsers.map((b) => populated(b.blockedDoc, 'user')).filter(Boolean)
    }
    shapeProfile(row)
    if (Array.isArray(row.following)) row.followingCount = row.following.length
    return row
}

const PRIVATE_PROFILE_OMIT = { deviceTokens: true, browserIds: true, webPushSubscriptions: true }

const findAdminProfile = async (id, populate) =>
    isValidId(id)
        ? shapeAdminProfile(await prisma.profile.findUnique({
            where: { id: String(id) },
            omit: PRIVATE_PROFILE_OMIT,
            include: profileGraphInclude(populate),
        }))
        : null

const AUTHOR_CARD = profileArgs(['fullName', 'displayName', 'profilePic', 'coverPic', 'bio'])
// The old .populate('author', '<fields>') did not populate author.user.
AUTHOR_CARD.select.userDoc = false

const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

exports.signUp = async (req, res, next) => {
    console.log('SignUp endpoint hit');
    console.log('Request body:', req.body);
    console.log('JWT_SECRET_KEY exists:', !!process.env.JWT_SECRET_KEY);

    let { fullName, email, password, role } = req.body

    try {
        // Validate required fields
        if (!fullName || !email || !password) {
            return res.status(400).json({
                message: 'Full name, email, and password are required'
            });
        }

        // Check if admin already exists
        let existingAdmin = await findAdminByEmail(email.toLowerCase());
        if (existingAdmin) {
            return res.status(400).json({
                message: `Admin account already exists with email ${email}`
            });
        }

        // Hash password
        let hashPassword = await bcrypt.hash(password, 10);

        // Create new admin
        let adminData = await prisma.admin.create({
            data: {
                fullName,
                email: email.toLowerCase(),
                password: hashPassword,
                role: role || 'admin'
            }
        });

        // Generate JWT token
        let accessToken = jwt.sign({
            admin_id: adminData._id,
            role: adminData.role
        }, SECRET_KEY, {
            expiresIn: '30d'
        });

        return res.status(201).json({
            message: 'Admin account created successfully',
            admin_id: adminData._id,
            fullName: adminData.fullName,
            email: adminData.email,
            role: adminData.role,
            accessToken
        });

    } catch (error) {
        next(error);
    }
}

exports.login = async (req, res, next) => {
    console.log('Login endpoint hit');
    console.log('Request body:', req.body);

    let { email, password } = req.body

    try {
        // Validate required fields
        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required'
            });
        }

        // Find admin by email
        let admin = await findAdminByEmail(email.toLowerCase());

        if (!admin) {
            return res.status(404).json({
                message: 'Admin account not found'
            });
        }

        // Verify password
        let matchPassword = await bcrypt.compare(password, admin.password);

        if (!matchPassword) {
            return res.status(401).json({
                message: 'Invalid password'
            });
        }

        // Generate JWT token
        let accessToken = jwt.sign({
            admin_id: admin._id,
            role: admin.role
        }, SECRET_KEY, {
            expiresIn: '30d'
        });

        return res.status(200).json({
            message: 'Login successful',
            admin_id: admin._id,
            fullName: admin.fullName,
            email: admin.email,
            role: admin.role,
            accessToken
        });

    } catch (error) {
        next(error);
    }
}

exports.deleteAccount = async (req, res, next) => {
    let { email, password } = req.body

    try {
        // Validate required fields
        if (!email || !password) {
            return res.status(400).json({
                message: 'Email and password are required'
            });
        }

        // Find admin by email
        let admin = await findAdminByEmail(email.toLowerCase());

        if (!admin) {
            return res.status(404).json({
                message: 'Admin account not found'
            });
        }

        // Verify password before deletion
        let matchPassword = await bcrypt.compare(password, admin.password);

        if (!matchPassword) {
            return res.status(401).json({
                message: 'Invalid password'
            });
        }

        // Delete admin account
        await prisma.admin.delete({ where: { id: admin.id } });

        return res.status(200).json({
            message: 'Admin account deleted successfully'
        });

    } catch (error) {
        next(error);
    }
}


const serializeInterestProfile = (interestProfile) => {
    if (!interestProfile) {
        return {
            lovedCategories: [],
            interestCount: 0,
            interestUpdatedAt: null
        };
    }

    const categories = interestProfile.categories instanceof Map
        ? Array.from(interestProfile.categories.entries())
        : Object.entries(jsonObject(interestProfile.categories));

    return {
        lovedCategories: categories
            .map(([name, score]) => ({ name, score: Number(score) || 0 }))
            .filter((category) => category.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, 10),
        interestCount: interestProfile.interactionCount || 0,
        interestUpdatedAt: interestProfile.updatedAt || interestProfile.createdAt || null
    };
};

exports.getProfiles = async (req, res, next) => {
    try {
        let profiles = (await prisma.profile.findMany({
            omit: PRIVATE_PROFILE_OMIT,
            include: profileGraphInclude(['connects']),
            take: 50,
        })).map(shapeAdminProfile);
        const rebuiltInterests = await rebuildInterestProfiles(profiles.map((profile) => profile._id));
        const interestProfiles = await prisma.userInterestProfile.findMany({
            where: { profile: { in: profiles.map((profile) => profile.id) } }
        });
        const interestsByProfile = new Map(interestProfiles.map((interestProfile) => [
            String(interestProfile.profile),
            serializeInterestProfile(interestProfile)
        ]));
        for (const [profileId, interestProfile] of rebuiltInterests) {
            interestsByProfile.set(profileId, serializeInterestProfile(interestProfile));
        }

        return res.status(200).json(profiles.map((profile) => ({
            ...profile,
            ...(interestsByProfile.get(String(profile._id)) || serializeInterestProfile(null))
        })));
    } catch (error) {
        next(error);
    }
}

exports.getProfile = async (req, res, next) => {
    try {
        const { id } = req.params;
        let profile = await findAdminProfile(id, ['connects', 'following', 'blockedUsers']);

        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        const interestProfile = await rebuildInterestProfile(profile._id);
        return res.status(200).json({
            ...profile,
            ...serializeInterestProfile(interestProfile)
        });
    } catch (error) {
        next(error);
    }
}

exports.updateProfile = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // Find the profile
        let profile = isValidId(id)
            ? await prisma.profile.findUnique({ where: { id: String(id) }, select: { id: true, user: true } })
            : null;
        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        // Update profile fields
        const profileFields = ['bio', 'presentAddress', 'permanentAddress', 'isActive', 'isVerified']
            .filter((field) => updateData[field] !== undefined);
        const userFields = ['firstName', 'surname', 'email', 'gender', 'DOB']
            .filter((field) => updateData[field] !== undefined);
        const pick = (fields) => Object.fromEntries(fields.map((field) => [field, updateData[field]]));

        // Update user fields
        if (profile.user && userFields.length) {
            await prisma.user.updateMany({ where: { id: profile.user }, data: pickModelFields('User', pick(userFields)) });
        }

        if (profileFields.length) {
            await prisma.profile.update({ where: { id: profile.id }, data: pickModelFields('Profile', pick(profileFields)) });
        }

        // Return updated profile
        const updatedProfile = await findAdminProfile(id, ['connects', 'following', 'blockedUsers']);

        return res.status(200).json({
            message: 'Profile updated successfully',
            profile: updatedProfile
        });
    } catch (error) {
        next(error);
    }
}

// Admin: Set a user's password without requiring current password
exports.setUserPassword = async (req, res, next) => {
    try {
        const { id } = req.params; // profile id
        const { newPassword, confirmPassword } = req.body || {};

        if (!newPassword || !confirmPassword) {
            return res.status(400).json({ message: 'New password and confirm password are required' });
        }

        if (newPassword !== confirmPassword) {
            return res.status(400).json({ message: 'New password and confirm password do not match' });
        }

        // Find profile and associated user
        const profile = isValidId(id)
            ? await prisma.profile.findUnique({ where: { id: String(id) }, select: { id: true, user: true } })
            : null;
        const user = profile?.user
            ? await prisma.user.findUnique({ where: { id: profile.user }, select: { id: true } })
            : null;
        if (!profile || !user) {
            return res.status(404).json({ message: 'Profile or user not found' });
        }

        // Hash and set the new password
        const hashed = await bcrypt.hash(newPassword, 10);
        await prisma.user.update({ where: { id: user.id }, data: { password: hashed } });

        return res.status(200).json({ message: 'Password updated successfully' });
    } catch (error) {
        next(error);
    }
}

exports.deleteProfile = async (req, res, next) => {
    let profileId = req.params.id || false

    try {

        let getProfile = profileId && isValidId(profileId)
            ? await prisma.profile.findUnique({ where: { id: String(profileId) }, select: { id: true, user: true } })
            : null

        if (getProfile?.user) {
            // Removes the profile, its user and everything that belongs to them.
            await deleteUserData(profileId)
            return res.json({ message: 'Account Deleted Successfully' })
        }

        // The Mongoose version never answered this case (the request hung).
        return res.json({ message: 'Account Deletion Failed' })
    } catch (error) {
        console.log(error)
        return res.json({ message: 'Account Deletion Failed' })
    }
}

/** .populate('parentPost') — the shared post as stored (author left as an id). */
const attachParentPosts = async (posts) => {
    const list = (Array.isArray(posts) ? posts : [posts]).filter(Boolean)
    const ids = [...new Set(list.map((post) => post.parentPost).filter((id) => typeof id === 'string'))]
    if (!ids.length) return
    const parents = (await prisma.post.findMany({
        where: { id: { in: ids } },
        include: postInclude({ author: false }),
    })).map(shapePost)
    const byId = new Map(parents.map((parent) => [parent.id, parent]))
    list.forEach((post) => {
        if (typeof post.parentPost === 'string') post.parentPost = byId.get(post.parentPost) || null
    })
}

const ADMIN_COMMENT_AUTHOR = profileArgs(['fullName', 'displayName', 'profilePic'], ['firstName', 'surname'])
const ADMIN_REPLY_AUTHOR = { select: { id: true, fullName: true, displayName: true, profilePic: true, user: true } }
const ADMIN_VIEWER = { select: { id: true, fullName: true, displayName: true, profilePic: true } }

exports.getPosts = async (req, res, next) => {
    try {
        let posts = (await prisma.post.findMany({
            include: postInclude({ author: AUTHOR_CARD, parent: false }),
            orderBy: { createdAt: 'desc' },
            take: 100,
        })).map(shapePost);
        await attachParentPosts(posts);

        console.log('Fetched posts:', posts.length);

        return res.status(200).json(posts);
    } catch (error) {
        next(error);
    }
}

exports.getPost = async (req, res, next) => {
    try {
        const { id } = req.params;

        let post = isValidId(id)
            ? shapePost(await prisma.post.findUnique({
                where: { id: String(id) },
                include: postInclude({
                    author: AUTHOR_CARD,
                    comments: commentInclude(ADMIN_COMMENT_AUTHOR, ADMIN_REPLY_AUTHOR),
                    viewers: ADMIN_VIEWER,
                }),
            }))
            : null;

        if (!post) {
            return res.status(404).json({ message: 'Post not found' });
        }
        await attachParentPosts(post);

        return res.status(200).json(post);
    } catch (error) {
        next(error);
    }
}

exports.updatePost = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // Find the post first
        let post = isValidId(id) ? await prisma.post.findUnique({ where: { id: String(id) }, select: { id: true } }) : null;
        if (!post) {
            return res.status(404).json({ message: 'Post not found' });
        }

        // Update post fields (content / text / isActive are not Post columns; Mongoose dropped them too)
        const fields = ['caption', 'feelings', 'location', 'audience', 'photos']
            .filter((field) => updateData[field] !== undefined);
        if (fields.length) {
            await prisma.post.update({
                where: { id: post.id },
                data: pickModelFields('Post', Object.fromEntries(fields.map((field) => [field, updateData[field]]))),
            });
        }

        // Return updated post with populated fields
        const updatedPost = shapePost(await prisma.post.findUnique({
            where: { id: post.id },
            include: postInclude({ author: AUTHOR_CARD }),
        }));
        await attachParentPosts(updatedPost);

        return res.status(200).json({
            message: 'Post updated successfully',
            post: updatedPost
        });
    } catch (error) {
        next(error);
    }
}

exports.deletePost = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Find the post first
        let post = isValidId(id) ? await prisma.post.findUnique({ where: { id: String(id) }, select: { id: true, photos: true } }) : null;
        if (!post) {
            return res.status(404).json({ message: 'Post not found' });
        }

        const result = await deleteContentWithComments('post', post.id);
        await deleteCloudinaryResources([post.photos, ...result.attachments]);

        return res.status(200).json({
            message: 'Post and all associated comments and replies deleted successfully',
            deletedComments: result.deletedComments,
            deletedReplies: result.deletedReplies
        });
    } catch (error) {
        next(error);
    }
}

/** Delete a post / watch / story, its comments and their replies. */
const deleteContentWithComments = async (kind, id) => {
    const { comments, replies, commentIds } = await deleteCommentsWhere({ [kind]: id })
    await prisma.$transaction([
        prisma.cmntReply.deleteMany({ where: { parent: { in: commentIds } } }),
        prisma.comment.deleteMany({ where: { id: { in: commentIds } } }),
    ])
    await removeContent(kind, id)
    return {
        deletedComments: comments.length,
        deletedReplies: replies.length,
        attachments: [...comments.map((comment) => comment.attachment), ...replies.map((reply) => reply.attachment)],
    }
}

// Watch Admin Functions
exports.getWatches = async (req, res, next) => {
    try {
        let watches = (await prisma.watch.findMany({
            include: watchInclude({ author: AUTHOR_CARD }),
            orderBy: { createdAt: 'desc' },
            take: 100,
        })).map(shapeWatch);

        console.log('Fetched watches:', watches.length);

        return res.status(200).json(watches);
    } catch (error) {
        next(error);
    }
}

exports.getWatch = async (req, res, next) => {
    try {
        const { id } = req.params;

        let watch = isValidId(id)
            ? shapeWatch(await prisma.watch.findUnique({
                where: { id: String(id) },
                include: watchInclude({
                    author: AUTHOR_CARD,
                    comments: commentInclude(ADMIN_COMMENT_AUTHOR, ADMIN_REPLY_AUTHOR),
                }),
            }))
            : null;

        if (!watch) {
            return res.status(404).json({ message: 'Watch not found' });
        }

        return res.status(200).json(watch);
    } catch (error) {
        next(error);
    }
}

exports.updateWatch = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // Find the watch first
        let watch = isValidId(id) ? await prisma.watch.findUnique({ where: { id: String(id) }, select: { id: true } }) : null;
        if (!watch) {
            return res.status(404).json({ message: 'Watch not found' });
        }

        // Update watch fields
        const fields = ['caption', 'feeling', 'audience'].filter((field) => updateData[field] !== undefined);
        if (fields.length) {
            await prisma.watch.update({
                where: { id: watch.id },
                data: pickModelFields('Watch', Object.fromEntries(fields.map((field) => [field, updateData[field]]))),
            });
        }

        // Return updated watch with populated fields
        const updatedWatch = shapeWatch(await prisma.watch.findUnique({
            where: { id: watch.id },
            include: watchInclude({ author: AUTHOR_CARD }),
        }));

        return res.status(200).json({
            message: 'Watch updated successfully',
            watch: updatedWatch
        });
    } catch (error) {
        next(error);
    }
}

exports.deleteWatch = async (req, res, next) => {
    try {
        const { id } = req.params;

        // Find the watch first
        let watch = isValidId(id)
            ? await prisma.watch.findUnique({ where: { id: String(id) }, select: { id: true, videoUrl: true, thumbnail: true } })
            : null;
        if (!watch) {
            return res.status(404).json({ message: 'Watch not found' });
        }

        const result = await deleteContentWithComments('watch', watch.id);
        await deleteCloudinaryResources([watch.videoUrl, watch.thumbnail, ...result.attachments]);

        return res.status(200).json({
            message: 'Watch and all associated comments and replies deleted successfully',
            deletedComments: result.deletedComments,
            deletedReplies: result.deletedReplies
        });
    } catch (error) {
        next(error);
    }
}

// Story Admin Functions
exports.getStories = async (req, res, next) => {
    try {
        const stories = (await prisma.story.findMany({
            include: storyInclude({ author: AUTHOR_CARD }),
            orderBy: { createdAt: 'desc' },
        })).map(shapeStory);

        return res.status(200).json(stories);
    } catch (error) {
        next(error);
    }
}

exports.deleteStory = async (req, res, next) => {
    try {
        const { id } = req.params;
        const story = isValidId(id)
            ? await prisma.story.findUnique({ where: { id: String(id) }, select: { id: true, image: true, music: true } })
            : null;

        if (!story) {
            return res.status(404).json({ message: 'Story not found' });
        }

        const result = await deleteContentWithComments('story', story.id);
        await deleteCloudinaryResources([story.image, story.music, ...result.attachments]);

        return res.status(200).json({
            message: 'Story and associated comments and replies deleted successfully',
            deletedComments: result.deletedComments
        });
    } catch (error) {
        next(error);
    }
}

// Admin: aggregated stats and recent activity
exports.getStats = async (req, res, next) => {
    try {
        const [
            totalUsers,
            totalProfiles,
            activeProfiles,
            totalPosts,
            totalWatches,
            totalComments
        ] = await Promise.all([
            prisma.user.count(),
            prisma.profile.count(),
            prisma.profile.count({ where: { isActive: true } }),
            prisma.post.count(),
            prisma.watch.count(),
            prisma.comment.count()
        ]);

        // Fetch recent items
        const [recentProfiles, recentPosts, recentWatches] = await Promise.all([
            prisma.profile.findMany({
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: { id: true, fullName: true, createdAt: true, user: true, userDoc: { select: { id: true, firstName: true, surname: true } } },
            }).then((rows) => populated(rows, 'user')),
            prisma.post.findMany({
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: { id: true, createdAt: true, author: true, authorDoc: { select: { id: true, fullName: true, displayName: true, profilePic: true } } },
            }).then((rows) => populated(rows, 'author')),
            prisma.watch.findMany({
                orderBy: { createdAt: 'desc' },
                take: 5,
                select: { id: true, createdAt: true, author: true, authorDoc: { select: { id: true, fullName: true, displayName: true, profilePic: true } } },
            }).then((rows) => populated(rows, 'author'))
        ]);

        const recentActivities = [
            ...recentProfiles.map(p => ({
                id: String(p._id),
                user: p.fullName || (p.user ? `${p.user.firstName} ${p.user.surname}` : 'Unknown'),
                action: 'Created profile',
                time: p.createdAt,
                type: 'user'
            })),
            ...recentPosts.map(post => ({
                id: String(post._id),
                user: post.author?.fullName || 'Unknown',
                action: 'Posted new content',
                time: post.createdAt,
                type: 'post'
            })),
            ...recentWatches.map(w => ({
                id: String(w._id),
                user: w.author?.fullName || 'Unknown',
                action: 'Published a watch',
                time: w.createdAt,
                type: 'watch'
            }))
        ]
        // Sort combined list by time desc and cap to 10
        .sort((a, b) => new Date(b.time) - new Date(a.time))
        .slice(0, 10);

        return res.status(200).json({
            totals: {
                users: totalUsers,
                profiles: totalProfiles,
                activeProfiles,
                posts: totalPosts,
                watches: totalWatches,
                comments: totalComments
            },
            recentActivities
        });
    } catch (error) {
        next(error);
    }
}

// Reports (Admin)
const REPORTER = {
    select: {
        id: true, fullName: true, displayName: true, profilePic: true, user: true,
        userDoc: { select: { id: true, firstName: true, surname: true } },
    },
}

const shapeReport = (report) => {
    if (!report) return report
    populated(report, 'targetPost', 'targetProfile', 'reportedBy')
    if (report.targetPost && typeof report.targetPost === 'object') populated(report.targetPost, 'author')
    if (report.targetProfile && typeof report.targetProfile === 'object') populated(report.targetProfile, 'user')
    if (report.reportedBy && typeof report.reportedBy === 'object') populated(report.reportedBy, 'user')
    return report
}

exports.getReportedPosts = async (req, res, next) => {
    try {
        const reports = (await prisma.report.findMany({
            where: { type: 'post' },
            include: {
                targetPostDoc: {
                    select: {
                        id: true, caption: true, type: true, photos: true, author: true, createdAt: true,
                        authorDoc: { select: { id: true, fullName: true, displayName: true, profilePic: true } },
                    },
                },
                reportedByDoc: REPORTER,
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
        })).map(shapeReport)
        return res.status(200).json(reports)
    } catch (error) {
        next(error)
    }
}

exports.getReportedProfiles = async (req, res, next) => {
    try {
        const reports = (await prisma.report.findMany({
            where: { type: 'profile' },
            include: {
                targetProfileDoc: {
                    select: {
                        id: true, fullName: true, displayName: true, username: true, profilePic: true, user: true,
                        userDoc: { select: { id: true, firstName: true, surname: true, email: true } },
                    },
                },
                reportedByDoc: REPORTER,
            },
            orderBy: { createdAt: 'desc' },
            take: 200,
        })).map(shapeReport)
        return res.status(200).json(reports)
    } catch (error) {
        next(error)
    }
}

exports.updateReportStatus = async (req, res, next) => {
    try {
        const { id } = req.params
        const { status } = req.body || {}
        if (!['open', 'reviewed', 'dismissed'].includes(status)) {
            return res.status(400).json({ message: 'Invalid status' })
        }
        const { count } = isValidId(id)
            ? await prisma.report.updateMany({ where: { id: String(id) }, data: { status } })
            : { count: 0 }
        const updated = count
            ? shapeReport(await prisma.report.findUnique({
                where: { id: String(id) },
                include: { targetPostDoc: true, targetProfileDoc: { omit: PRIVATE_PROFILE_OMIT } },
            }))
            : null
        if (!updated) {
            return res.status(404).json({ message: 'Report not found' })
        }
        return res.status(200).json(updated)
    } catch (error) {
        next(error)
    }
}

exports.forgotPassword = async (req, res, next) => {
    const email = String(req.body?.email || '').trim().toLowerCase();

    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        const admin = await findAdminByEmail(email);

        if (!admin) {
            return res.status(200).json({
                message: 'If an admin account with that email exists, a reset link has been sent.'
            });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        await prisma.admin.update({
            where: { id: admin.id },
            data: { resetPasswordToken: hashedResetToken, resetPasswordExpire: new Date(Date.now() + 15 * 60 * 1000) },
        });

        const resetUrl = `${getAdminAppUrl()}/reset-password/${resetToken}`;
        const text = [
            `Hello ${admin.fullName || 'Admin'},`,
            '',
            'We received a request to reset your Connect Admin password.',
            '',
            'Reset your password using this link:',
            resetUrl,
            '',
            'This link expires in 15 minutes.',
            'If you did not request this, you can ignore this email safely.',
        ].join('\n');

        const html = `
            <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:560px">
              <h2 style="margin:0 0 12px">Reset your admin password</h2>
              <p>Hello ${escapeHtml(admin.fullName || 'Admin')},</p>
              <p>We received a request to reset your Connect Admin password.</p>
              <p style="margin:24px 0">
                <a href="${escapeHtml(resetUrl)}"
                   style="display:inline-block;background:#4f46e5;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">
                  Reset password
                </a>
              </p>
              <p style="word-break:break-all;font-size:13px;color:#555">Or open this link:<br/>${escapeHtml(resetUrl)}</p>
              <p style="color:#555;font-size:13px">This link expires in 15 minutes.</p>
            </div>
        `;

        try {
            await sendEmailNotification(
                admin.email,
                'Connect Admin password reset',
                text,
                'Connect Admin',
                { html, throwOnError: true }
            );
        } catch (mailError) {
            await prisma.admin.update({
                where: { id: admin.id },
                data: { resetPasswordToken: null, resetPasswordExpire: null },
            });
            console.error('Admin forgot password email send failed:', mailError.message || mailError);
            return res.status(500).json({
                message: 'Unable to send reset email right now. Please try again later.',
            });
        }

        return res.status(200).json({
            message: 'If an admin account with that email exists, a reset link has been sent.'
        });
    } catch (error) {
        next(error);
    }
};

exports.resetPassword = async (req, res, next) => {
    const resetToken = req.params?.token;
    const { password, confirmPassword } = req.body || {};

    if (!resetToken) {
        return res.status(400).json({ message: 'Reset token is required' });
    }

    if (!password || !confirmPassword) {
        return res.status(400).json({ message: 'Password and confirm password are required' });
    }

    if (password !== confirmPassword) {
        return res.status(400).json({ message: 'Password and confirm password do not match' });
    }

    if (String(password).length < 6) {
        return res.status(400).json({ message: 'Password must be at least 6 characters' });
    }

    try {
        const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');
        const admin = await prisma.admin.findFirst({
            where: {
                resetPasswordToken: hashedResetToken,
                resetPasswordExpire: { gt: new Date() },
            },
        });

        if (!admin) {
            return res.status(400).json({ message: 'Invalid or expired reset link' });
        }

        await prisma.admin.update({
            where: { id: admin.id },
            data: { password: await bcrypt.hash(password, 10), resetPasswordToken: null, resetPasswordExpire: null },
        });

        return res.status(200).json({ message: 'Password reset successful. Please login.' });
    } catch (error) {
        next(error);
    }
};
