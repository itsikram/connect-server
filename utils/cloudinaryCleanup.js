const { getAccountForCloudName, withCloudinaryAccount } = require('./cloudinary')

const isMissingCloudinaryAsset = (error) =>
    error?.http_code === 404 ||
    error?.statusCode === 404 ||
    error?.response?.status === 404 ||
    /\bstatus code 404\b/i.test(String(error?.message || error))

const getCloudinaryAsset = (value) => {
    if (typeof value !== 'string' || !value.includes('/upload/')) return null

    let url
    try {
        url = new URL(value)
    } catch {
        return null
    }

    const pathParts = url.pathname.split('/').filter(Boolean)
    let cloudName
    let resourceType
    let parts
    if (url.hostname === 'res.cloudinary.com') {
        [cloudName, resourceType] = pathParts
        if (pathParts[2] !== 'upload') return null
        parts = pathParts.slice(3)
    } else if (url.hostname.endsWith('.res.cloudinary.com')) {
        cloudName = url.hostname.split('.')[0]
        resourceType = pathParts[0]
        if (pathParts[1] !== 'upload') return null
        parts = pathParts.slice(2)
    } else {
        return null
    }

    if (!['image', 'video', 'raw'].includes(resourceType)) return null
    const versionIndex = parts.findIndex((part) => /^v\d+$/.test(part))
    const publicIdParts = versionIndex >= 0 ? parts.slice(versionIndex + 1) : parts
    if (!publicIdParts.length) return null

    const lastPart = publicIdParts[publicIdParts.length - 1]
    if (resourceType !== 'raw' && /\.[^./]+$/.test(lastPart)) {
        publicIdParts[publicIdParts.length - 1] = lastPart.replace(/\.[^./]+$/, '')
    }

    return {
        cloudName,
        publicId: publicIdParts.join('/'),
        resourceType,
    }
}

const deleteCloudinaryResources = async (values) => {
    const assets = new Map()
    for (const value of values.flat(Infinity)) {
        const asset = getCloudinaryAsset(value)
        if (asset) assets.set(`${asset.cloudName}:${asset.resourceType}:${asset.publicId}`, asset)
    }

    const results = await Promise.all([...assets.values()].map(async (asset) => {
        try {
            const result = await withCloudinaryAccount(
                getAccountForCloudName(asset.cloudName),
                (cloudinary) => cloudinary.uploader.destroy(asset.publicId, {
                    resource_type: asset.resourceType,
                    type: 'upload',
                    invalidate: true,
                }),
            )
            return { ...asset, result }
        } catch (error) {
            if (isMissingCloudinaryAsset(error)) {
                return { ...asset, result: { result: 'not found' } }
            }
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
