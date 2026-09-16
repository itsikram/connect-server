const { v2: cloudinary } = require('cloudinary');
const mongoose = require('mongoose');
const {
  getAccountConfig: getConfiguredAccountConfig,
  withCloudinaryConfig,
} = require('../utils/cloudinary');
const { deleteCloudinaryResources } = require('../utils/cloudinaryCleanup');

const defaultConfig = {
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || '',
  api_key: process.env.CLOUDINARY_API_KEY || '',
  api_secret: process.env.CLOUDINARY_API_SECRET || '',
};

cloudinary.config(defaultConfig);

const RESOURCE_TYPES = ['image', 'video', 'raw'];
const AUDIO_FORMATS = new Set(['aac', 'flac', 'm4a', 'mp3', 'oga', 'ogg', 'opus', 'wav', 'weba', 'webm']);
const migrationJobs = new Map();

async function listResources(resourceType) {
  if (!cloudinary?.api || typeof cloudinary.api.resources !== 'function') {
    throw new Error('Cloudinary API client is unavailable');
  }
  const resources = [];
  let nextCursor;

  do {
    const result = await cloudinary.api.resources({
      resource_type: resourceType,
      type: 'upload',
      max_results: 500,
      ...(nextCursor ? { next_cursor: nextCursor } : {}),
    }) || {};
    resources.push(...(Array.isArray(result.resources) ? result.resources : []));
    nextCursor = result.next_cursor;
  } while (nextCursor);

  return resources;
}

const getConfiguredAccounts = () => {
  return [{ id: 'default', config: getConfiguredAccountConfig('default') }];
};

const isAudioResource = (resource) => AUDIO_FORMATS.has(String(resource.format || '').toLowerCase());

const getLegacyDatabaseResources = async (legacy) => {
  if (!mongoose.connection.db || !legacy?.cloud_name) return [];
  const marker = `res.cloudinary.com/${legacy.cloud_name}/`;
  const found = new Map();
  const visit = (value) => {
    if (typeof value === 'string' && value.includes(marker) && value.includes('/upload/')) {
      try {
        const url = new URL(value);
        const parts = url.pathname.split('/').filter(Boolean);
        const resourceType = parts[1];
        const uploadIndex = parts.indexOf('upload');
        if (!['image', 'video', 'raw'].includes(resourceType) || uploadIndex < 0) return;
        const publicParts = parts.slice(uploadIndex + 1);
        const versionIndex = publicParts.findIndex((part) => /^v\d+$/.test(part));
        const publicIdParts = versionIndex >= 0 ? publicParts.slice(versionIndex + 1) : publicParts;
        if (!publicIdParts.length) return;
        const last = publicIdParts.length - 1;
        if (resourceType !== 'raw') publicIdParts[last] = publicIdParts[last].replace(/\.[^./]+$/, '');
        const originalLastPart = publicParts[publicParts.length - 1] || '';
        const publicId = publicIdParts.join('/');
        const format = originalLastPart.match(/\.([a-z0-9]+)$/i)?.[1] || '';
        found.set(`${resourceType}:${publicId}`, {
          secure_url: value,
          public_id: publicId,
          resource_type: resourceType,
          type: 'upload',
          format,
        });
      } catch {}
      return;
    }
    if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  for (const collection of await mongoose.connection.db.collections()) {
    if (collection.collectionName.startsWith('system.')) continue;
    for await (const document of collection.find({})) visit(document);
  }
  return [...found.values()];
};

const listResourcesForAccount = async (account) => {
  const result = await withCloudinaryConfig(account.config, async () => {
    const resourceResults = await Promise.all(RESOURCE_TYPES.map((resourceType) => listResources(resourceType)));
    let usage = null;
    try {
      usage = await cloudinary.api.usage();
    } catch (error) {
      usage = { error: getCloudinaryErrorMessage(error) };
    }
    return { grouped: resourceResults, usage };
  });
  return {
    account: account.id,
    usage: result.usage || {},
    resources: result.grouped.flat().map((resource) => ({
      ...resource,
      cloudinary_account: account.id,
      cloudinary_cloud_name: account.config.cloud_name,
      cloudinary_source: {
        account: account.id,
        cloud_name: account.config.cloud_name,
      },
    })),
  };
};

const getCloudinaryErrorMessage = (error) => (
  error?.error?.message ||
  error?.message ||
  (typeof error === 'string' ? error : '') ||
  'Cloudinary request failed'
);

const isValidCloudName = (value) => /^[a-zA-Z0-9_-]{1,64}$/.test(value);

const getAccountConfig = (account, label) => {
  if (!account || typeof account !== 'object') {
    throw new Error(`${label} Cloudinary account is required`);
  }

  const cloud_name = String(account.cloud_name || '').trim();
  const api_key = String(account.api_key || '').trim();
  const api_secret = String(account.api_secret || '').trim();

  if (!isValidCloudName(cloud_name) || !api_key || !api_secret) {
    throw new Error(`${label} Cloudinary credentials are incomplete or invalid`);
  }

  return { cloud_name, api_key, api_secret };
};

const replaceCloudinaryReferences = async (resources, source, destination) => {
  const replacements = new Map();
  const addReplacement = (from, to) => {
    if (typeof from === 'string' && from && typeof to === 'string' && to && from !== to) {
      replacements.set(from, to);
    }
  };

  resources.forEach((resource) => {
    const sourceResource = resource.source || {};
    const destinationResource = resource.destination || {};
    addReplacement(sourceResource.secure_url, destinationResource.secure_url);
    addReplacement(sourceResource.url, destinationResource.url);
    addReplacement(sourceResource.public_id, destinationResource.public_id);
    addReplacement(sourceResource.asset_id, destinationResource.asset_id);
  });

  const sourceMarker = `res.cloudinary.com/${source.cloud_name}/`;
  const destinationMarker = `res.cloudinary.com/${destination.cloud_name}/`;
  const database = { documentsUpdated: 0, referencesUpdated: 0, errors: [] };

  const visit = (value, path, updates) => {
    if (typeof value === 'string') {
      const exact = replacements.get(value);
      const replaced = exact || (value.includes(sourceMarker) ? value.replaceAll(sourceMarker, destinationMarker) : null);
      if (replaced && replaced !== value) updates[path] = replaced;
      return;
    }
    if (!value || typeof value !== 'object') return;
    Object.entries(value).forEach(([key, child]) => {
      if (key === '_id' || key === '__v') return;
      visit(child, path ? `${path}.${key}` : key, updates);
    });
  };

  const connection = mongoose.connection;
  if (connection.readyState !== 1 || !connection.db) {
    throw new Error('MongoDB must be connected before Cloudinary references can be updated');
  }

  const collections = await connection.db.collections();
  for (const collection of collections) {
    if (collection.collectionName.startsWith('system.')) continue;
    try {
      const cursor = collection.find({});
      for await (const document of cursor) {
        const updates = {};
        visit(document, '', updates);
        if (Object.keys(updates).length) {
          await collection.updateOne({ _id: document._id }, { $set: updates });
          database.documentsUpdated += 1;
          database.referencesUpdated += Object.keys(updates).length;
        }
      }
    } catch (error) {
      database.errors.push({ collection: collection.collectionName, reason: error.message || 'Database update failed' });
    }
  }

  return database;
};

const deleteSourceResources = async (resources, source) => {
  const deleted = [];
  const failed = [];
  await withCloudinaryConfig(source, async () => {
    for (const resource of resources) {
      if (!resource.public_id) continue;
      try {
        const result = await cloudinary.uploader.destroy(resource.public_id, {
          resource_type: resource.resource_type || 'image',
          type: resource.type || 'upload',
          invalidate: true,
        });
        if (result?.result === 'ok' || result?.result === 'not found') deleted.push(resource.public_id);
        else failed.push({ public_id: resource.public_id, reason: result?.result || 'Delete failed' });
      } catch (error) {
        failed.push({ public_id: resource.public_id, reason: error?.message || 'Delete failed' });
      }
    }
  });
  return { deleted, failed };
};

const migrateResources = async (resources, overwrite, onProgress) => {
  const result = { migrated: [], skipped: [], failed: [] };

  const addMigrated = (resource, uploaded, reused = false) => {
    result.migrated.push({
      identifier: resource.public_id || resource.asset_id || resource.secure_url,
      source: {
        secure_url: resource.secure_url,
        url: resource.url,
        public_id: resource.public_id,
        asset_id: resource.asset_id,
        resource_type: resource.resource_type,
        type: resource.type,
      },
      destination: {
        secure_url: uploaded.secure_url,
        url: uploaded.url,
        public_id: uploaded.public_id,
        asset_id: uploaded.asset_id,
        resource_type: uploaded.resource_type,
        ...(reused ? { reused: true } : {}),
      },
    });
  };

  const deleteMigratedSourceResources = async (resources, source) => {
    const deleted = [];
    const failed = [];
    await withCloudinaryConfig(source, async () => {
      for (const resource of resources) {
        if (!resource.public_id) continue;
        try {
          const result = await cloudinary.uploader.destroy(resource.public_id, {
            resource_type: resource.resource_type || 'image',
            type: resource.type || 'upload',
            invalidate: true,
          });
          if (result?.result === 'ok' || result?.result === 'not found') deleted.push(resource.public_id);
          else failed.push({ public_id: resource.public_id, reason: result?.result || 'Delete failed' });
        } catch (error) {
          failed.push({ public_id: resource.public_id, reason: error?.message || 'Delete failed' });
        }
      }
    });
    return { deleted, failed };
  };

  for (const resource of resources) {
    const identifier = resource.public_id || resource.asset_id || resource.secure_url;
    if (!resource.secure_url || !identifier) {
      result.skipped.push({ identifier: identifier || 'unknown', reason: 'Resource has no delivery URL' });
      onProgress?.(result);
      continue;
    }

    try {
      const uploaded = await cloudinary.uploader.upload(resource.secure_url, {
        resource_type: resource.resource_type || 'image',
        type: resource.type || 'upload',
        public_id: resource.public_id,
        overwrite,
        invalidate: true,
      });
      addMigrated(resource, uploaded);
    } catch (error) {
      let destinationLookupReason = '';
      // A previous migration may already have copied this public ID. Reconcile
      // that asset instead of reporting it as failed and skipping DB updates.
      if (resource.public_id) {
        try {
          const existing = await cloudinary.api.resource(resource.public_id, {
            resource_type: resource.resource_type || 'image',
            type: resource.type || 'upload',
          });
          addMigrated(resource, existing, true);
          onProgress?.(result);
          continue;
        } catch (lookupError) {
          // Preserve the original upload error when no destination asset exists.
          destinationLookupReason = lookupError?.error?.message || lookupError?.message || '';
        }
      }

      result.failed.push({
        identifier,
        reason: [
          error?.error?.message || error.message || 'Upload failed',
          destinationLookupReason ? `Destination lookup: ${destinationLookupReason}` : '',
        ].filter(Boolean).join('. '),
      });
    }
    onProgress?.(result);
  }

  return result;
};

exports.listResources = async (req, res, next) => {
  try {
    const accounts = getConfiguredAccounts();
    const accountResults = await Promise.allSettled(accounts.map(listResourcesForAccount));
    const resources = accountResults
      .filter((result) => result.status === 'fulfilled')
      .flatMap((result) => result.value.resources)
      .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));
    const usageByAccount = accountResults
      .filter((result) => result.status === 'fulfilled')
      .reduce((result, current) => {
        result[current.value.account] = current.value.usage;
        return result;
      }, {});
    const warnings = accountResults
      .map((result, index) => result.status === 'rejected'
        ? {
          account: accounts[index].id,
          cloud_name: accounts[index].config.cloud_name || null,
          message: getCloudinaryErrorMessage(result.reason),
        }
        : null)
      .filter(Boolean);

    if (!resources.length && warnings.length) {
      return res.status(502).json({
        message: 'Unable to load Cloudinary resources from the configured accounts.',
        warnings,
      });
    }

    return res.json({
      resources,
      total: resources.length,
      totals: RESOURCE_TYPES.reduce((result, type) => {
        result[type] = resources.filter((resource) => resource.resource_type === type).length;
        return result;
      }, {}),
      accounts: accounts.map((account) => ({
        id: account.id,
        cloud_name: account.config.cloud_name,
        total: resources.filter((resource) => resource.cloudinary_account === account.id).length,
        usage: usageByAccount[account.id] || null,
      })),
      warnings,
      usageByAccount,
    });
  } catch (error) {
    return next(error);
  }
};

exports.deleteResources = async (req, res, next) => {
  try {
    const assets = Array.isArray(req.body?.assets) ? req.body.assets : [];
    if (!assets.length) return res.status(400).json({ message: 'At least one asset is required' });
    const results = await deleteCloudinaryResources(assets.map((asset) => asset.secure_url).filter(Boolean));
    const failed = results.filter((item) => item.error || !['ok', 'not found'].includes(item.result?.result));
    return res.json({
      deleted: results.length - failed.length,
      deletedAssets: results.filter((item) => !failed.includes(item)).map((item) => ({
        cloud_name: item.cloudName,
        public_id: item.publicId,
        resource_type: item.resourceType,
      })),
      failed: failed.map((item) => ({
        cloud_name: item.cloudName,
        public_id: item.publicId,
        resource_type: item.resourceType,
        message: item.error?.message || item.result?.result || 'Delete failed',
      })),
    });
  } catch (error) {
    return next(error);
  }
};

exports.migrateResources = async (req, res, next) => {
  try {
    const source = getAccountConfig(req.body?.source, 'Source');
    const destination = getAccountConfig(req.body?.destination, 'Destination');
    const overwrite = req.body?.overwrite !== false;
    const resourceTypes = Array.isArray(req.body?.resourceTypes)
      ? req.body.resourceTypes.filter((type) => RESOURCE_TYPES.includes(type))
      : RESOURCE_TYPES;
    const deleteSource = req.body?.deleteSource === true;
    if (!resourceTypes.length) {
      return res.status(400).json({ message: 'Select at least one asset type to migrate' });
    }

    const jobId = require('crypto').randomUUID();
    migrationJobs.set(jobId, { status: 'starting', total: 0, processed: 0, migrated: 0, skipped: 0, failed: 0 });
    void (async () => {
      try {
        const resources = await withCloudinaryConfig(source, async () => {
          const grouped = await Promise.all(resourceTypes.map(listResources));
          return grouped.flat();
        });
        const job = migrationJobs.get(jobId);
        job.status = 'running';
        job.total = resources.length;
        const result = await withCloudinaryConfig(destination, () =>
          migrateResources(resources, overwrite, (current) => {
            const latest = migrationJobs.get(jobId);
            latest.processed = current.migrated.length + current.skipped.length + current.failed.length;
            latest.migrated = current.migrated.length;
            latest.skipped = current.skipped.length;
            latest.failed = current.failed.length;
          }),
        );
        const database = await replaceCloudinaryReferences(result.migrated, source, destination);
        const sourceCleanup = deleteSource
          ? await deleteMigratedSourceResources(result.migrated.map((item) => ({
            ...item.source,
            resource_type: item.source.resource_type || item.destination.resource_type,
          })), source)
          : null;
        migrationJobs.set(jobId, {
          ...migrationJobs.get(jobId),
          status: 'completed',
          processed: resources.length,
          migrated: result.migrated.length,
          skipped: result.skipped.length,
          failed: result.failed.length + (sourceCleanup?.failed.length || 0),
          database,
          sourceCleanup,
          details: result,
        });
      } catch (error) {
        migrationJobs.set(jobId, { ...migrationJobs.get(jobId), status: 'failed', error: error.message || 'Migration failed' });
      }
    })();
    return res.status(202).json({ jobId });
  } catch (error) {
    return next(error);
  }
};

exports.migrateConfiguredResources = async (req, res, next) => {
  try {
    const accounts = getConfiguredAccounts();
    const accountMap = new Map(accounts.map((account) => [account.id, account]));
    const jobId = require('crypto').randomUUID();
    migrationJobs.set(jobId, { status: 'starting', total: 0, processed: 0, migrated: 0, skipped: 0, failed: 0 });

    void (async () => {
      try {
        const accountResults = await Promise.all(accounts.map(async (account) => {
          try {
            return { account, resources: (await listResourcesForAccount(account)).resources };
          } catch (error) {
            if (account.id === 'legacy') {
              return { account, resources: await getLegacyDatabaseResources(account.config) };
            }
            throw error;
          }
        }));
        const plans = [];
        accountResults.forEach(({ account, resources }) => {
          resources.forEach((resource) => {
            const destinationId = resource.resource_type === 'image'
              ? 'image'
              : resource.resource_type === 'video' && isAudioResource(resource)
                ? 'image'
                : resource.resource_type === 'video'
                  ? 'video'
                  : null;
            if (destinationId && destinationId !== account.id) {
              plans.push({ resource, source: account, destination: accountMap.get(destinationId) });
            }
          });
        });

        const job = migrationJobs.get(jobId);
        job.status = 'running';
        job.total = plans.length;
        const database = { documentsUpdated: 0, referencesUpdated: 0, errors: [] };
        const sourceCleanup = { deleted: [], failed: [] };

        for (const plan of plans) {
          const result = await withCloudinaryConfig(plan.destination.config, () =>
            migrateResources([plan.resource], true),
          );
          const migrated = result.migrated[0];
          if (!migrated) {
            job.failed += result.failed.length;
            job.skipped += result.skipped.length;
            job.processed += 1;
            continue;
          }
          const updated = await replaceCloudinaryReferences([migrated], plan.source.config, plan.destination.config);
          database.documentsUpdated += updated.documentsUpdated;
          database.referencesUpdated += updated.referencesUpdated;
          database.errors.push(...updated.errors);
          const cleanup = await deleteSourceResources([migrated.source], plan.source.config);
          sourceCleanup.deleted.push(...cleanup.deleted);
          sourceCleanup.failed.push(...cleanup.failed);
          job.migrated += 1;
          job.processed += 1;
        }

        migrationJobs.set(jobId, { ...job, status: 'completed', database, sourceCleanup });
      } catch (error) {
        migrationJobs.set(jobId, { ...migrationJobs.get(jobId), status: 'failed', error: error.message || 'Configured migration failed' });
      }
    })();
    return res.status(202).json({ jobId });
  } catch (error) {
    return next(error);
  }
};

exports.getMigrationStatus = (req, res) => {
  const job = migrationJobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ message: 'Migration job not found' });
  return res.json(job);
};
