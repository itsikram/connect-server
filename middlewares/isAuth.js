const jwt = require('jsonwebtoken')
const Profile = require('../models/Profile')


const SECRET_KEY = process.env.JWT_SECRET_KEY;


let isAuth = async(req,res,next) => {

    try {
        let token = req.headers.authorization
        let {user_id} = jwt.verify(token,SECRET_KEY)
        let profileData = await Profile.findOne({user: user_id}).populate('user')
        if(!profileData) {
            return res.json({
                message: 'You are not a authenticated User'
            }).status(401)
        }
        req.profile = profileData
        next()
        
    } catch (error) {
        next(error)
    }

}

module.exports = isAuth