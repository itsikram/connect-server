const { v2: cloudinary } = require('cloudinary');

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
});

const RESOURCE_TYPES = ['image', 'video', 'raw'];

async function listResources(resourceType) {
  const resources = [];
  let nextCursor;

  do {
    const result = await cloudinary.api.resources({
      resource_type: resourceType,
      type: 'upload',
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    });
    resources.push(...(result.resources || []));
    nextCursor = result.next_cursor;
  } while (nextCursor);

  return resources;
}

exports.listResources = async (req, res, next) => {
  try {
    const grouped = await Promise.all(RESOURCE_TYPES.map(listResources));
    const resources = grouped
      .flat()
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return res.json({
      resources,
      total: resources.length,
      totals: RESOURCE_TYPES.reduce((result, type, index) => {
        result[type] = grouped[index].length;
        return result;
      }, {}),
    });
  } catch (error) {
    return next(error);
  }
};
