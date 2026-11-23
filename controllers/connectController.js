const { prisma } = require('../utils/db')
// Mongoose ignored unknown keys; Prisma rejects them, so keep only real columns.
const { Prisma } = require('@prisma/client')
const CONNECT_FIELDS = Object.keys(Prisma.ConnectScalarFieldEnum).filter(
    (key) => !['id', 'createdAt', 'updatedAt'].includes(key)
)
const connectData = (body = {}) => {
    const data = {}
    for (const key of CONNECT_FIELDS) {
        if (body && body[key] !== undefined) data[key] = body[key]
    }
    return data
}

// Admin saves used to add a new row each time (they checked the Mongo-era
// `_id`, which Prisma rows do not have), so read and update the newest row:
// that is the one holding the admin's latest settings (APK URL, version...).
const findCurrent = () => prisma.connect.findFirst({ orderBy: { updatedAt: 'desc' } })

exports.getData=async(req,res,next)=>{
    try {
        let connect = await findCurrent()
        if(connect) {
            return res.status(200).json(connect)
        }
        // Stays a 200 as before: the admin settings page does not catch errors here.
        return res.status(200).json({message: 'Connect data not found'})
    } catch (error) {
        next(error)
    }
}

exports.updateData=async(req,res,next)=>{
    try {
        let connect = await findCurrent()
        if(connect?.id) {
            let updatedConnect = await prisma.connect.update({ where: { id: connect.id }, data: connectData(req.body) })
            if(updatedConnect) {
                return res.status(200).json(updatedConnect)
            }
        }else {
            let connect = await prisma.connect.create({ data: connectData(req.body) })
            if(connect) {
                return res.status(200).json(connect)
            }
        }
        return res.status(404).json({message: 'Connect data not found'})
    } catch (error) {
        next(error)
    }
}