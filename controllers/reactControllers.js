const Post = require('../models/Post')
const Story = require('../models/Story')
const Profile = require('../models/Profile')
const { saveNotification } = require('./notificationController')

exports.postAddReact = async (req, res, next) => {
    try {

        let profile = (req.profile._id).toString()
        let myProfileData = req.profile
        let { reactType, id, postType } = req.body
        let io = req.app.get('io')

        let friendProfile = ''

        switch (postType) {
            case 'post':
                friendProfile = (await Post.findOne({ _id: id }).populate('author')).author
                await Post.findOneAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                let addPostReact = await Post.findOneAndUpdate({
                    _id: id
                }, {
                    $push: {
                        reacts: {
                            profile,
                            type: reactType
                        }
                    }

                }, { new: true })



                if ((friendProfile._id).toString() !== profile) {
                    let postReactNotification = {
                        receiverId: friendProfile._id,
                        text: `${myProfileData.fullName} Reacted your post`,
                        link: '/post/' + addPostReact._id,
                        type: 'postCommentReply',
                        icon: friendProfile.profilePic
                    }
                    saveNotification(io, postReactNotification)
                }


                return res.json(addPostReact).status(200)
                break;
            case 'story':

            friendProfile = (await Story.findOne({ _id: id }).populate('author')).author

                await Story.findOneAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                let addStoryReact = await Story.findOneAndUpdate({
                    _id: id
                }, {
                    $push: {
                        reacts: {
                            profile,
                            type: reactType
                        }
                    }

                }, { new: true })

                if ((friendProfile._id).toString() !== profile) {
                    let postStoryNotification = {
                        receiverId: friendProfile._id,
                        text: `${myProfileData.fullName} Reacted your Story`,
                        link: '/story/' + addStoryReact._id,
                        type: 'postCommentReply',
                        icon: friendProfile.profilePic
                    }
                    saveNotification(io, postStoryNotification)
                }

                return res.json(addStoryReact).status(200)
                break;
            case 'watch':

                break;

            default:
                break;
        }


    } catch (error) {
        console.log(error)
    }
}

exports.postRemoveReact = async (req, res, next) => {
    try {
        let profile = req.profile._id
        let { id, postType,reactor } = req.body
        let io = req.app.get('io')

        switch (postType) {
            case 'post':
                let removePostReact = await Post.findByIdAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: reactor,
                        }
                    }
                }, { new: true })

                return res.json(removePostReact)
                break;
            case 'story':
                let removeStoryReact = await Story.findByIdAndUpdate({
                    _id: id
                }, {
                    $pull: {
                        reacts: {
                            profile: profile,
                        }
                    }
                }, { new: true })

                return res.json(removeStoryReact)
                break;

            default:

                break;
        }



    } catch (error) {
        next(error)
    }
}

exports.addStoryReact = async (req, res, next) => {

}
exports.deleteStoryReact = async (req, res, next) => {

}

