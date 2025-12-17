const jwt = require('jsonwebtoken')
const Profile = require('../models/Profile')


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