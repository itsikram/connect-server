const multer = require('multer')
const path = require('path')


const profilePicStorage = multer.diskStorage({
    destination: (req,file,cb) => {
        cb(null,'public/image/profilePic/')
    },
    filename: (req,file,cb) => {
        cb(null,file.fieldname+"-"+ Date.now() +"-"+ file.originalname)
    }
})

const profilePicUpload = multer({
    storage: profilePicStorage,
    fileFilter: (req,file,cb) => {
        let Types = /jpeg|jpg|png|gif/
        let extName = Types.test(path.extname(file.originalname).toLocaleLowerCase())
        let mimeType = Types.test(file.mimetype)

        if(extName && mimeType) {
            cb(null,true)
        }else {
            cb(new Error('Please Upload Supported Files'))
        }
    },
})

module.exports = profilePicUpload