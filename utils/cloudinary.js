const { v2: cloudinary } = require('cloudinary')
let operationQueue = Promise.resolve()

const getAccountConfig = (account) => {
    const prefix = account === 'video' ? 'CLOUDINARY_VIDEO' : 'CLOUDINARY_IMAGE'
    const dedicated = [
        process.env[`${prefix}_CLOUD_NAME`],
        process.env[`${prefix}_API_KEY`],
        process.env[`${prefix}_API_SECRET`],
    ]
    const useDedicated = dedicated.every((value) => String(value || '').trim())
    return {
        cloud_name: (useDedicated ? dedicated[0] : process.env.CLOUDINARY_CLOUD_NAME) || '',
        api_key: (useDedicated ? dedicated[1] : process.env.CLOUDINARY_API_KEY) || '',
        api_secret: (useDedicated ? dedicated[2] : process.env.CLOUDINARY_API_SECRET) || '',
    }
}

const getCloudinaryAccount = (resourceType) =>
    resourceType === 'video' || resourceType === 'raw' ? 'video' : 'image'

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

const getAccountForCloudName = (cloudName) => {
    if (cloudName && cloudName === getAccountConfig('video').cloud_name) return 'video'
    return 'image'
}

module.exports = {
    getAccountConfig,
    getCloudinaryAccount,
    getAccountForCloudName,
    withCloudinaryConfig,
    withCloudinaryAccount,
}
