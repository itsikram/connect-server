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

exports.getData=async(req,res,next)=>{
    let connect = await prisma.connect.findFirst()
    if(connect) {
        return res.json(connect).status(200)
    }
    return res.json({message: 'Connect data not found'}).status(404)
}

exports.updateData=async(req,res,next)=>{
    let connect = await prisma.connect.findFirst()
    if(connect?._id) {
        let updatedConnect = await prisma.connect.update({ where: { id: connect.id }, data: connectData(req.body) })
        if(updatedConnect) {
            return res.json(updatedConnect).status(200)
        }
    }else {
        let connect = await prisma.connect.create({ data: connectData(req.body) })
        if(connect) {
            return res.json(connect).status(200)
        }
    }
    return res.json({message: 'Connect data not found'}).status(404)

}