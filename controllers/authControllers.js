const User = require('../models/User')
const Profile = require('../models/Profile')
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const Story = require('../models/Story');
const Post = require('../models/Post');
const Watch = require('../models/Watch');
const Message = require('../models/Message');
const Comment = require('../models/Comment');
const CmntReply = require('../models/CmntReply');
const Setting = require('../models/Setting');
const FaceEndCoding = require('../models/FaceEncoding');
const { OAuth2Client } = require('google-auth-library');
const crypto = require('crypto');
const SECRET_KEY = process.env.JWT_SECRET_KEY;
const deleteUserData = require('../utils/deleteUserData')
const sendEmailNotification = require('../utils/sendEmailNotification');


// Google OAuth2 Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);




const getClientAppUrl = () => {
    const url = (
        process.env.CLIENT_URL ||
        process.env.REACT_APP_URL ||
        process.env.FRONTEND_URL ||
        'http://localhost:3000'
    ).replace(/\/+$/, '');

    // Live reset emails must not point at localhost — set CLIENT_URL on the host (Render env)
    if (
        process.env.NODE_ENV === 'production' &&
        /localhost|127\.0\.0\.1/i.test(url)
    ) {
        console.warn(
            `CLIENT_URL is "${url}" in production. ` +
                'Set CLIENT_URL to your live web app URL (e.g. https://connect-zfgx.onrender.com) in Render env vars.'
        );
    }

    return url;
};

const escapeHtml = (value) =>
    String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');

exports.forgotPassword = async (req, res, next) => {
    const rawEmail = req.body?.email || '';
    const email = String(rawEmail).trim().toLowerCase();

    if (!email) {
        return res.status(400).json({ message: 'Email is required' });
    }

    try {
        const user = await User.findOne({ email });

        // Always return a generic success to avoid email enumeration
        if (!user) {
            return res.status(200).json({
                message: 'If an account with that email exists, a reset link has been sent.'
            });
        }

        if (!user.password) {
            return res.status(400).json({
                message: 'This account uses Google sign-in. Please continue with Google.'
            });
        }

        const resetToken = crypto.randomBytes(32).toString('hex');
        const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        user.resetPasswordToken = hashedResetToken;
        user.resetPasswordExpire = Date.now() + 15 * 60 * 1000;
        await user.save();

        const resetUrl = `${getClientAppUrl()}/reset-password/${resetToken}`;
        const displayName = user.firstName || 'there';
        const text = [
            `Hello ${displayName},`,
            '',
            'We received a request to reset your Connect account password.',
            '',
            'Reset your password using this link:',
            resetUrl,
            '',
            'This link expires in 15 minutes.',
            'If you did not request this, you can ignore this email safely.',
        ].join('\n');

        const html = `
            <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111;max-width:560px">
              <h2 style="margin:0 0 12px">Reset your Connect password</h2>
              <p>Hello ${escapeHtml(displayName)},</p>
              <p>We received a request to reset your Connect account password.</p>
              <p style="margin:24px 0">
                <a href="${escapeHtml(resetUrl)}"
                   style="display:inline-block;background:#6a77ff;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600">
                  Reset password
                </a>
              </p>
              <p style="word-break:break-all;font-size:13px;color:#555">Or open this link:<br/>${escapeHtml(resetUrl)}</p>
              <p style="color:#555;font-size:13px">This link expires in 15 minutes. If you did not request this, you can ignore this email.</p>
            </div>
        `;

        try {
            await sendEmailNotification(
                user.email,
                'Connect password reset',
                text,
                'Connect',
                { html, throwOnError: true }
            );
        } catch (mailError) {
            user.resetPasswordToken = undefined;
            user.resetPasswordExpire = undefined;
            await user.save();
            console.error('Forgot password SMTP send failed:', mailError.message || mailError);
            return res.status(500).json({
                message: 'Unable to send reset email right now. Please try again later.',
            });
        }

        return res.status(200).json({
            message: 'If an account with that email exists, a reset link has been sent.'
        });
    } catch (e) {
        next(e)
    }
}

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

    try {
        const hashedResetToken = crypto.createHash('sha256').update(resetToken).digest('hex');

        const user = await User.findOne({
            resetPasswordToken: hashedResetToken,
            resetPasswordExpire: { $gt: Date.now() }
        });

        if (!user) {
            return res.status(400).json({ message: 'Invalid or expired reset link' });
        }

        user.password = await bcrypt.hash(password, 10);
        user.resetPasswordToken = undefined;
        user.resetPasswordExpire = undefined;
        await user.save();

        return res.status(200).json({ message: 'Password reset successful. Please login.' });
    } catch (e) {
        next(e)
    }
}

exports.signUp = async (req, res, next) => {
    let { firstName, surname, password, DOB, gender } = req.body
    let email = (req.body.email).toLowerCase();

    try {

        let isUser = await User.find({ email });
        if (isUser.length === 0) {

            let hashPassword = await bcrypt.hash(password, 10);

            let saveUser = User({
                firstName,
                surname,
                email,
                password: hashPassword,
                DOB,
                gender
            })

            let userData = await saveUser.save();
            let profileData = new Profile({
                user: userData._id,
                fullName: firstName + ' ' + surname,
                displayName: surname
            })

            let profile = await profileData.save()

            if (profile) {

                let updatedUser = await User.findOneAndUpdate({ _id: saveUser._id }, { profile: profile._id }, { new: true })


                if (updatedUser) {
                    let accessToken = jwt.sign({ user_id: updatedUser._id }, SECRET_KEY, {
                        expiresIn: '5d'
                    })

                    return res.status(201).json({
                        firstName: updatedUser.firstName,
                        user_id: updatedUser._id,
                        surname: updatedUser.surname,
                        profile: updatedUser.profile,
                        accessToken
                    })
                }

            }


            return res.status(201).json({
                message: 'Account Created successfully'
            })

        } else {
            return res.status(200).json({ message: `Already Created a account with ${email}` });
        }




    } catch (e) {
        next(e)
    }

}
exports.changePass = async (req, res, next) => {
    let { newPassword, currentPassword, confirmPassword } = req.body
    let myProfile = req.profile || ''
    let userId = req.profile.user._id || ''

    // Validate all required fields
    if (!newPassword || !currentPassword || !confirmPassword) {
        return res.status(400).json({ message: 'All password fields are required' })
    }

    if (newPassword !== confirmPassword) {
        return res.status(400).json({ message: 'Your New Password and confirm password is not same' })
    }

    try {
        let user = await User.findOne({ profile: myProfile._id });
        if (!user) {
            return res.status(404).json({ message: 'User not found' })
        }

        let matchPassword = await bcrypt.compare(currentPassword, user.password)
        if (!matchPassword) {
            return res.status(400).json({ message: 'Your Current Password Is Invalid' })
        }

        // Only proceed with hashing if we have a valid new password
        let newHashPassword = await bcrypt.hash(newPassword, 10);
        let updatedUser = await User.findOneAndUpdate({ _id: userId }, {
            password: newHashPassword
        }, { new: true })

        if (updatedUser) {
            let profile = await Profile.findOne({ _id: myProfile._id }).populate('user')
            let accessToken = jwt.sign({ user_id: userId.toString() }, SECRET_KEY, {
                expiresIn: '30d'
            })

            let resData = {
                firstName: updatedUser.firstName,
                user_id: updatedUser._id,
                surname: updatedUser.surname,
                profile: profile._id,
                accessToken
            }

            return res.status(200).json(resData)
        }
    } catch (e) {
        next(e)
    }
}
exports.changeEmail = async (req, res, next) => {
    let { email } = req.body
    let userId = req.profile.user._id || ''
    try {
        let updatedUser = await User.findOneAndUpdate({ _id: userId }, { email }, { new: true })

        if (updatedUser) {


            let accessToken = jwt.sign({ user_id: updatedUser._id }, SECRET_KEY, {
                expiresIn: '30d'
            })

            return res.status(200).json({
                firstName: updatedUser.firstName,
                user_id: updatedUser._id,
                surname: updatedUser.surname,
                profile: updatedUser.profile,
                accessToken
            })

        }


    } catch (e) {
        next(e)
    }

}

exports.login = async (req, res, next) => {
    let password = req.body.password;
    let email = (req.body.email)?.toLowerCase();

    try {

        let user = await User.findOne({ email })

        if (!user) {
            return res.status(404).json({
                'message': 'You Don\' Having An account'
            })
        }

        let matchPassword = await bcrypt.compare(password, user.password)

        if (!matchPassword) {
            return res.status(401).json({
                message: 'Invalid Password'
            })
        }



        let accessToken = jwt.sign({ user_id: user._id }, SECRET_KEY, {
            expiresIn: '30d'
        })

        return res.status(202).json({
            firstName: user.firstName,
            user_id: user._id,
            surname: user.surname,
            profile: user.profile,
            accessToken
        })

    } catch (e) {
        next(e)
    }


}

exports.googleSignIn = async (req, res, next) => {
    const { googleId, email, name, photo, familyName, givenName, idToken } = req.body;
    const startedAt = Date.now();
    console.log('[google] sign-in attempt', {
        email,
        googleIdPresent: Boolean(googleId)
    });

    try {
        // Verify the Google ID token
        const ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });
        console.log('[google] idToken verified', { ms: Date.now() - startedAt });

        const payload = ticket.getPayload();
        const googleUserId = payload['sub'];

        // Verify that the Google ID matches what we received
        if (googleUserId !== googleId) {
            return res.status(401).json({
                message: 'Invalid Google authentication'
            });
        }

        // Check if user already exists
        let user = await User.findOne({ email: email.toLowerCase() });

        if (user) {
            // User exists, check if they have Google ID associated
            if (!user.googleId) {
                // Add Google ID to existing user
                user.googleId = googleId;
                await user.save();
            }

            // Generate JWT token
            let accessToken = jwt.sign({ user_id: user._id }, SECRET_KEY, {
                expiresIn: '30d'
            });

            return res.status(202).json({
                firstName: user.firstName,
                user_id: user._id,
                surname: user.surname,
                profile: user.profile,
                accessToken
            });
        } else {
            // Create new user with Google authentication
            let newUser = new User({
                firstName: givenName || name.split(' ')[0],
                surname: familyName || name.split(' ').slice(1).join(' ') || '',
                email: email.toLowerCase(),
                googleId: googleId,
                // No password for Google users
                password: null,
                // Set default values for required fields
                DOB: null,
                gender: 'other'
            });

            let userData = await newUser.save();

            // Create profile for the new user
            let profileData = new Profile({
                user: userData._id,
                fullName: name,
                displayName: familyName || name.split(' ')[0],
                profilePic: photo || null
            });

            let profile = await profileData.save();

            if (profile) {
                // Update user with profile reference
                let updatedUser = await User.findOneAndUpdate(
                    { _id: userData._id }, 
                    { profile: profile._id }, 
                    { new: true }
                );

                if (updatedUser) {
                    let accessToken = jwt.sign({ user_id: updatedUser._id }, SECRET_KEY, {
                        expiresIn: '30d'
                    });

                    return res.status(201).json({
                        firstName: updatedUser.firstName,
                        user_id: updatedUser._id,
                        surname: updatedUser.surname,
                        profile: updatedUser.profile,
                        accessToken
                    });
                }
            }

            return res.status(500).json({
                message: 'Failed to create user profile'
            });
        }

    } catch (error) {
        console.error('[google] idToken verification FAILED', {
            ms: Date.now() - startedAt,
            message: error && error.message ? error.message : error
        });
        return res.status(500).json({
            message: 'Google authentication failed'
        });
    }
}

exports.deleteAccount = async (req, res, next) => {
    const authUserId = req.profile?.user?._id?.toString()
    if (!authUserId) {
        return res.status(401).json({ message: 'Unauthorized' })
    }

    const userId = authUserId

    try {
        let getUser = await User.findById(userId)

        if (getUser) {
            await User.findByIdAndDelete(userId)
            let profileId = getUser.profile

            if (profileId) {
                await Profile.findByIdAndDelete(profileId)
                await deleteUserData(profileId)
                return res.status(200).json({ message: 'Account Deleted Successfully' })
            }
        }

        return res.status(404).json({ message: 'Account not found' })
    } catch (error) {
        console.log(error)
        return res.status(500).json({ message: 'Account Deletion Failed' })
    }
}
