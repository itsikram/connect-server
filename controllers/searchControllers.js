
const Profile = require('../models/Profile')
const Post = require('../models/Post')
const Watch = require('../models/Watch')

exports.getSearchResult = async (req, res, next) => {
    try {

        let queryString = req.query.input || ''

        let searchResponse = {
            posts: null,
            users: null,
            videos: null
        }

        let usersFound = await Profile.find({
            fullName: {
                $regex: queryString,
                $options: 'i'
            }
        })

        if (usersFound) {
            searchResponse.users = usersFound
        }

        let postsFound = await Post.find({
            caption: {
                $regex: queryString,
                $options: 'i'
            }
        }).populate('author')

        if (postsFound) {
            searchResponse.posts = postsFound
        }
        let videosFound = await Watch.find({
            caption: {
                $regex: queryString,
                $options: 'i'
            }
        }).populate('author')

        if (videosFound) {
            searchResponse.videos = videosFound
        }

        if (usersFound || postsFound || videosFound) {
            return res.json(searchResponse).status(200)

        }











        return res.json({ message: 'Not Profile Found' }).status(400)


    } catch (e) { next(e) }
}
