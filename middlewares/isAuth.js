const jwt = require('jsonwebtoken')
const Profile = require('../models/Profile')
const User = require('../models/User')


const SECRET_KEY = process.env.JWT_SECRET_KEY;


let isAuth = async(req,res,next) => {

    try {
        let token = req.headers.authorization
        console.log('token', token)
        
        // Check if token exists
        if (!token) {
            return res.status(401).json({
                message: 'Authentication token is required'
            })
        }
        
        let {user_id} = jwt.verify(token,SECRET_KEY)
        let profileData = await Profile.findOne({user: user_id}).populate('user')
        if(!profileData) {
            return res.status(401).json({
                message: 'You are not a authenticated User'
            })
        }
        
        // Update user online status to true
        const updateData = {
            isActive: true
        }
        
        // Update location if provided in headers or body
        const latitude = req.headers['x-latitude'] || req.body?.latitude
        const longitude = req.headers['x-longitude'] || req.body?.longitude
        const locationAccuracy = req.headers['x-location-accuracy'] || req.body?.locationAccuracy || req.body?.accuracy
        
        if (latitude && longitude) {
            updateData.lastLocation = {
                latitude: parseFloat(latitude),
                longitude: parseFloat(longitude),
                timestamp: Date.now(),
                ...(locationAccuracy && { accuracy: parseFloat(locationAccuracy) })
            }
        }
        
        // Update profile with online status and location
        await Profile.findByIdAndUpdate(
            profileData._id,
            updateData,
            { new: false } // Don't return updated doc, just update it
        )
        
        // Update lastLogin in User model
        await User.findByIdAndUpdate(
            user_id,
            { lastLogin: Date.now() }
        )
        
        // Reload profile data to get updated values if needed
        profileData = await Profile.findOne({user: user_id}).populate('user')
        
        req.profile = profileData
        next()
        
    } catch (error) {
        // Handle JWT verification errors
        if (error.name === 'JsonWebTokenError' || error.name === 'TokenExpiredError') {
            return res.status(401).json({
                message: 'Invalid or expired token'
            })
        }
        next(error)
    }

}

module.exports = isAuth