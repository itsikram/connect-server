const { v2: cloudinary } = require('cloudinary')

const cloudName = process.env.CLOUDINARY_CLOUD_NAME
cloudinary.config({
    cloud_name: cloudName || '',
    api_key: process.env.CLOUDINARY_API_KEY || '',
    api_secret: process.env.CLOUDINARY_API_SECRET || '',
})

const getCloudinaryAsset = (value) => {
    if (typeof value !== 'string' || !value.includes('/upload/')) return null

    let url
    try {
        url = new URL(value)
    } catch {
        return null
    }

    if (cloudName && url.hostname !== `${cloudName}.res.cloudinary.com`) return null

    const marker = '/upload/'
    const uploadIndex = url.pathname.indexOf(marker)
    if (uploadIndex < 0) return null

    const parts = url.pathname.slice(uploadIndex + marker.length)
        .split('/')
        .filter(Boolean)
    const versionIndex = parts.findIndex((part) => /^v\d+$/.test(part))
    const publicIdParts = versionIndex >= 0 ? parts.slice(versionIndex + 1) : parts
    if (!publicIdParts.length) return null

    const resourceType = url.pathname.slice(0, uploadIndex).split('/').filter(Boolean).pop()
    if (!['image', 'video', 'raw'].includes(resourceType)) return null

    const lastPart = publicIdParts[publicIdParts.length - 1]
    if (resourceType !== 'raw' && /\.[^./]+$/.test(lastPart)) {
        publicIdParts[publicIdParts.length - 1] = lastPart.replace(/\.[^./]+$/, '')
    }

    return {
        publicId: publicIdParts.join('/'),
        resourceType,
    }
}

const deleteCloudinaryResources = async (values) => {
    const assets = new Map()
    for (const value of values.flat(Infinity)) {
        const asset = getCloudinaryAsset(value)
        if (asset) assets.set(`${asset.resourceType}:${asset.publicId}`, asset)
    }

    const results = await Promise.all([...assets.values()].map(async (asset) => {
        try {
            const result = await cloudinary.uploader.destroy(asset.publicId, {
                resource_type: asset.resourceType,
                type: 'upload',
                invalidate: true,
            })
            return { ...asset, result }
        } catch (error) {
            console.error('[cloudinary-cleanup] failed to delete asset', {
                publicId: asset.publicId,
                resourceType: asset.resourceType,
                error: error?.message || error,
            })
            return { ...asset, error }
        }
    }))

    return results
}

module.exports = {
    deleteCloudinaryResources,
    getCloudinaryAsset,
}
