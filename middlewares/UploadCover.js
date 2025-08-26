const multer = require("multer")
const path =  require("path")

let coverPicStorage = multer.diskStorage({
    destination: (req,file,cb) => {
        cb(null,'')
    },
    filename: (req, file, cb) => {
        cb(null, file.fieldname + '-' + Date.now() + '-' + file.originalname)
    }
})

const coverPicUpload = multer({
    storage: coverPicStorage,
    fileFilter: (req,file,cb) => {
        const Types = /jpeg|jpg|png|gif/
        const extName = Types.test(path.extname(file.originalname).toLocaleLowerCase())
        const mimeType = Types.test(file.mimetype)

        if(extName && mimeType) {
            cb(null,true)
        }else {
            cb(new Error('Pleasze Enter supported file'))
        }
    }
})
module.exports = coverPicUpload