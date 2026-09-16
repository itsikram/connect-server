const { v2: cloudinary } = require('cloudinary')
let operationQueue = Promise.resolve()

const getAccountConfig = () => ({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
    api_key: process.env.CLOUDINARY_API_KEY || '',
    api_secret: process.env.CLOUDINARY_API_SECRET || '',
})

const getCloudinaryAccount = () => 'default'

const withCloudinaryConfig = async (config, operation) => {
    const run = operationQueue.then(async () => {
        const previous = cloudinary.config()
        cloudinary.config(config)
        try {
            return await operation(cloudinary)
        } finally {
            cloudinary.config(previous)
        }
    })
    operationQueue = run.catch(() => undefined)
    return run
}

const withCloudinaryAccount = (account, operation) =>
    withCloudinaryConfig(getAccountConfig(account), operation)

const getAccountForCloudName = () => 'default'

module.exports = {
    getAccountConfig,
    getCloudinaryAccount,
    getAccountForCloudName,
    withCloudinaryConfig,
    withCloudinaryAccount,
}
