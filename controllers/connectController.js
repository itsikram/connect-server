const Connect = require('../models/Connect')
exports.getData=async(req,res,next)=>{
    let connect = await Connect.findOne()
    if(connect) {
        return res.json(connect).status(200)
    }
    return res.json({message: 'Connect data not found'}).status(404)
}

exports.updateData=async(req,res,next)=>{
    let connect = await Connect.findOne()
    if(connect?._id) {
        let updatedConnect = await Connect.findOneAndUpdate({_id: connect._id},{...req.body},{new: true})
        if(updatedConnect) {
            return res.json(updatedConnect).status(200)
        }
    }else {
        let connect = await Connect.create(req.body)
        if(connect) {
            return res.json(connect).status(200)
        }
    }
    return res.json({message: 'Connect data not found'}).status(404)

}