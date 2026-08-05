const Admin = require('../models/Admin')
const Profile = require('../models/Profile')
const User = require('../models/User')
const Post = require('../models/Post')
const Watch = require('../models/Watch')
const Comment = require('../models/Comment')
const CmntReply = require('../models/CmntReply')
const Report = require('../models/Report')
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const SECRET_KEY = process.env.JWT_SECRET_KEY;
const deleteUserData = require('../utils/deleteUserData')
const sendEmailNotification = require('../utils/sendEmailNotification')

const getAdminAppUrl = () => {
    return (
        process.env.ADMIN_URL ||
        process.env.NEXT_PUBLIC_ADMIN_URL ||
        'http://localhost:5000'
    ).replace(/\/+$/, '');
};

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
        let existingAdmin = await Admin.findOne({ email: email.toLowerCase() });
        if (existingAdmin) {
            return res.status(400).json({
                message: `Admin account already exists with email ${email}`
            });
        }

        // Hash password
        let hashPassword = await bcrypt.hash(password, 10);

        // Create new admin
        let newAdmin = new Admin({
            fullName,
            email: email.toLowerCase(),
            password: hashPassword,
            role: role || 'admin'
        });

        let adminData = await newAdmin.save();

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
        let admin = await Admin.findOne({ email: email.toLowerCase() });

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
        let admin = await Admin.findOne({ email: email.toLowerCase() });

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
        await Admin.findByIdAndDelete(admin._id);

        return res.status(200).json({
            message: 'Admin account deleted successfully'
        });

    } catch (error) {
        next(error);
    }
}


exports.getProfiles = async (req, res, next) => {
    try {
        let profiles = await Profile.find().populate(['user', 'friends']).limit(50);
        return res.status(200).json(profiles);
    } catch (error) {
        next(error);
    }
}

exports.getProfile = async (req, res, next) => {
    try {
        const { id } = req.params;
        let profile = await Profile.findById(id).populate(['user', 'friends', 'following', 'blockedUsers']);

        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        return res.status(200).json(profile);
    } catch (error) {
        next(error);
    }
}

exports.updateProfile = async (req, res, next) => {
    try {
        const { id } = req.params;
        const updateData = req.body;

        // Find the profile
        let profile = await Profile.findById(id).populate('user');
        if (!profile) {
            return res.status(404).json({ message: 'Profile not found' });
        }

        // Update profile fields
        if (updateData.bio !== undefined) profile.bio = updateData.bio;
        if (updateData.presentAddress !== undefined) profile.presentAddress = updateData.presentAddress;
        if (updateData.permanentAddress !== undefined) profile.permanentAddress = updateData.permanentAddress;
        if (updateData.isActive !== undefined) profile.isActive = updateData.isActive;

        // Update user fields
        if (profile.user) {
            if (updateData.firstName !== undefined) profile.user.firstName = updateData.firstName;
            if (updateData.surname !== undefined) profile.user.surname = updateData.surname;
            if (updateData.email !== undefined) profile.user.email = updateData.email;
            if (updateData.gender !== undefined) profile.user.gender = updateData.gender;
            if (updateData.DOB !== undefined) profile.user.DOB = updateData.DOB;

            await profile.user.save();
        }

        await profile.save();

        // Return updated profile
        const updatedProfile = await Profile.findById(id).populate(['user', 'friends', 'following', 'blockedUsers']);

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
        const profile = await Profile.findById(id).populate('user');
        if (!profile || !profile.user) {
            return res.status(404).json({ message: 'Profile or user not found' });
        }

        // Hash and set the new password
        const hashed = await bcrypt.hash(newPassword, 10);
        profile.user.password = hashed;
        await profile.user.save();

        return res.status(200).json({ message: 'Password updated successfully' });
    } catch (error) {
        next(error);
    }
}

exports.deleteProfile = async (req, res, next) => {
    let profileId = req.params.id || false

    try {

        let getProfile = await Profile.findById(profileId)

        if (getProfile) {
            await Profile.findByIdAndDelete(profileId)

            if (getProfile.user?._id) {
                await User.findByIdAndDelete(getProfile.user?._id)
    
                if (profileId) {
                    await deleteUserData(profileId)
                    return res.json({ message: 'Account Deleted Successfully' })
                }
            }
           
        }



    } catch (error) {
        console.log(error)
        return res.json({ message: 'Account Deletion Failed' })
    }
}

exports.getPosts = async (req, res, next) => {
    try {
        let posts = await Post.find()
            .populate('author', 'fullName displayName profilePic coverPic bio')
            .populate('parentPost')
            .sort({ createdAt: -1 })
            .limit(100);

        console.log('Fetched posts:', posts.length);
        
        return res.status(200).json(posts);
    } catch (error) {
        next(error);
    }
}

exports.getPost = async (req, res, next) => {
    try {
        const { id } = req.params;
        
        let post = await Post.findById(id)
            .populate('author', 'fullName displayName profilePic coverPic bio')
            .populate('parentPost')
            .populate({
                path: 'comments',
                populate: [
                    {
                        path: 'author',
                        select: 'fullName displayName profilePic',
                        populate: {
                            path: 'user',
                            select: 'firstName surname'
                        }
                    },
                    {
                        path: 'replies',
                        populate: {
                            path: 'author',
                            select: 'fullName displayName profilePic'
                        }
                    }
                ]
            })
            .populate('viewers', 'fullName displayName profilePic');

        if (!post) {
            return res.status(404).json({ message: 'Post not found' });
        }

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
        let post = await Post.findById(id);
        if (!post) {
            return res.status(404).json({ message: 'Post not found' });
        }

        // Update post fields
        if (updateData.caption !== undefined) post.caption = updateData.caption;
        if (updateData.content !== undefined) post.content = updateData.content;
        if (updateData.text !== undefined) post.text = updateData.text;
        if (updateData.feelings !== undefined) post.feelings = updateData.feelings;
        if (updateData.location !== undefined) post.location = updateData.location;
        if (updateData.audience !== undefined) post.audience = updateData.audience;
        if (updateData.isActive !== undefined) post.isActive = updateData.isActive;
        if (updateData.photos !== undefined) post.photos = updateData.photos;

        await post.save();

        // Return updated post with populated fields
        const updatedPost = await Post.findById(id)
            .populate('author', 'fullName displayName profilePic coverPic bio')
            .populate('parentPost');

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
        let post = await Post.findById(id);
        if (!post) {
            return res.status(404).json({ message: 'Post not found' });
        }
        
        // Find all comments associated with this post
        const comments = await Comment.find({ post: id });
        
        // Delete all comment replies for each comment
        for (const comment of comments) {
            await CmntReply.deleteMany({ parent: comment._id });
        }
        
        // Delete all comments for this post
        await Comment.deleteMany({ post: id });
        
        // Finally delete the post
        await Post.findByIdAndDelete(id);
        
        return res.status(200).json({ 
            message: 'Post and all associated comments and replies deleted successfully',
            deletedComments: comments.length,
            deletedReplies: comments.reduce((total, comment) => total + comment.replies.length, 0)
        });
    } catch (error) {
        next(error);
    }
}

// Watch Admin Functions
exports.getWatches = async (req, res, next) => {
    try {
        let watches = await Watch.find()
            .populate('author', 'fullName displayName profilePic coverPic bio')
            .sort({ createdAt: -1 })
            .limit(100);

        console.log('Fetched watches:', watches.length);
        
        return res.status(200).json(watches);
    } catch (error) {
        next(error);
    }
}

exports.getWatch = async (req, res, next) => {
    try {
        const { id } = req.params;
        
        let watch = await Watch.findById(id)
            .populate('author', 'fullName displayName profilePic coverPic bio')
            .populate({
                path: 'comments',
                populate: [
                    {
                        path: 'author',
                        select: 'fullName displayName profilePic',
                        populate: {
                            path: 'user',
                            select: 'firstName surname'
                        }
                    },
                    {
                        path: 'replies',
                        populate: {
                            path: 'author',
                            select: 'fullName displayName profilePic'
                        }
                    }
                ]
            });

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
        let watch = await Watch.findById(id);
        if (!watch) {
            return res.status(404).json({ message: 'Watch not found' });
        }

        // Update watch fields
        if (updateData.caption !== undefined) watch.caption = updateData.caption;
        if (updateData.feeling !== undefined) watch.feeling = updateData.feeling;
        if (updateData.audience !== undefined) watch.audience = updateData.audience;

        await watch.save();

        // Return updated watch with populated fields
        const updatedWatch = await Watch.findById(id)
            .populate('author', 'fullName displayName profilePic coverPic bio');

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
        let watch = await Watch.findById(id);
        if (!watch) {
            return res.status(404).json({ message: 'Watch not found' });
        }
        
        // Find all comments associated with this watch
        const comments = await Comment.find({ watch: id });
        
        // Delete all comment replies for each comment
        for (const comment of comments) {
            await CmntReply.deleteMany({ parent: comment._id });
        }
        
        // Delete all comments for this watch
        await Comment.deleteMany({ watch: id });
        
        // Finally delete the watch
        await Watch.findByIdAndDelete(id);
        
        return res.status(200).json({ 
            message: 'Watch and all associated comments and replies deleted successfully',
            deletedComments: comments.length,
            deletedReplies: comments.reduce((total, comment) => total + comment.replies.length, 0)
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
            User.countDocuments({}),
            Profile.countDocuments({}),
            Profile.countDocuments({ isActive: true }),
            Post.countDocuments({}),
            Watch.countDocuments({}),
            Comment.countDocuments({})
        ]);

        // Fetch recent items
        const [recentProfiles, recentPosts, recentWatches] = await Promise.all([
            Profile.find({}).sort({ createdAt: -1 }).limit(5).populate('user', 'firstName surname'),
            Post.find({}).sort({ createdAt: -1 }).limit(5).populate('author', 'fullName displayName profilePic'),
            Watch.find({}).sort({ createdAt: -1 }).limit(5).populate('author', 'fullName displayName profilePic')
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
exports.getReportedPosts = async (req, res, next) => {
    try {
        const reports = await Report.find({ type: 'post' })
            .populate({ path: 'targetPost', populate: { path: 'author', select: 'fullName displayName profilePic' } })
            .populate({ path: 'reportedBy', select: 'fullName displayName profilePic', populate: { path: 'user', select: 'firstName surname' } })
            .sort({ createdAt: -1 })
            .limit(200)
        return res.status(200).json(reports)
    } catch (error) {
        next(error)
    }
}

exports.getReportedProfiles = async (req, res, next) => {
    try {
        const reports = await Report.find({ type: 'profile' })
            .populate({ path: 'targetProfile', populate: { path: 'user', select: 'firstName surname email' } })
            .populate({ path: 'reportedBy', select: 'fullName displayName profilePic', populate: { path: 'user', select: 'firstName surname' } })
            .sort({ createdAt: -1 })
            .limit(200)
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
        const updated = await Report.findByIdAndUpdate(id, { status }, { new: true })
            .populate('targetPost')
            .populate('targetProfile')
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
        const admin = await Admin.findOne({ email });

        if (!admin) {
            return res.status(200).json({
                message: 'If an admin account with that email exists, a reset link has been sent.'
            });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        admin.resetPasswordToken = hashedResetToken;
        admin.resetPasswordExpire = Date.now() + 15 * 60 * 1000;
        await admin.save();

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
            admin.resetPasswordToken = undefined;
            admin.resetPasswordExpire = undefined;
            await admin.save();
            console.error('Admin forgot password SMTP send failed:', mailError.message || mailError);
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
        const admin = await Admin.findOne({
            resetPasswordToken: hashedResetToken,
            resetPasswordExpire: { $gt: Date.now() },
        });

        if (!admin) {
            return res.status(400).json({ message: 'Invalid or expired reset link' });
        }

        admin.password = await bcrypt.hash(password, 10);
        admin.resetPasswordToken = undefined;
        admin.resetPasswordExpire = undefined;
        await admin.save();

        return res.status(200).json({ message: 'Password reset successful. Please login.' });
    } catch (error) {
        next(error);
    }
};

