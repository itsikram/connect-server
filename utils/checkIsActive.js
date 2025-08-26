const Profile = require('../models/Profile')
const User = require('../models/User')
const mongoose = require('mongoose')
module.exports = async (profileId, userId = null) => {
    let isActive = false

    let profile;
    let userLastLogin;


    if (mongoose.isValidObjectId(userId)) {

        let user = await User.findById(userId);

        if (user.lastLogin) {
            userLastLogin = user.lastLogin;
        }

    } else if (mongoose.isValidObjectId(profileId)) {
        profile = await Profile.findById(profileId).populate('user');

        if (profile.user.lastLogin) {
            userLastLogin = profile.user.lastLogin;
        }
    }


    let currentTime = Date.now();
    const fiveMinutes = (5 * 60 * 1000);
    const diff = Math.abs(userLastLogin - currentTime);



    if (diff > fiveMinutes) {
        isActive = false
    } else {
        isActive = true
    }

    return {
        isActive,
        lastLogin: userLastLogin
    }

}