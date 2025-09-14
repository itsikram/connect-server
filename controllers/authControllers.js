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
const SECRET_KEY = process.env.JWT_SECRET_KEY;
const deleteUserData = require('../utils/deleteUserData')


// Google OAuth2 Client
const googleClient = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);




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

            return res.json(resData).status(202)
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
    console.log('google',req.body)

    try {
        // Verify the Google ID token
        const ticket = await googleClient.verifyIdToken({
            idToken: idToken,
            audience: process.env.GOOGLE_CLIENT_ID,
        });

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
        console.error('Google sign-in error:', error);
        return res.status(500).json({
            message: 'Google authentication failed'
        });
    }
}

exports.deleteAccount = async (req, res, next) => {
    let userData = req.body.userData
    let userId = userData.user_id

    try {

        let getUser = await User.findById(userId)

        if (getUser) {
            await User.findByIdAndDelete(userId)
            let profileId = getUser.profile

            if (profileId) {
                await Profile.findByIdAndDelete(profileId)
                await deleteUserData(profileId)
                return res.json({ message: 'Account Deleted Successfully' })
            }
        }

    } catch (error) {
        console.log(error)
        return res.json({ message: 'Account Deletion Failed' })

    }





}
