// In-process cache for hot reads (single-server deployments).
//
// Every entry carries tags — the Prisma model names its data came from. The
// Prisma client extension (config/prisma.js) calls invalidateModels() after
// every write, so a cached value never outlives a change to a table it was
// built from (on this process). Entries also expire after their TTL.
//
// With several servers behind one database (PEER_SERVERS, multi-server mode)
// a write on another server cannot reach this process, so set CACHE_DISABLED=1
// there (or keep the TTLs short).
const MAX_ENTRIES = Number(process.env.CACHE_MAX_ENTRIES) || 5000;

const disabled = () => process.env.CACHE_DISABLED === "1" || Boolean(process.env.PEER_SERVERS);

// key -> { value, expires, tags }
const entries = new Map();
// tag -> Set<key>
const keysByTag = new Map();
// key -> Promise (requests already computing this key)
const inFlight = new Map();
const stats = { hits: 0, misses: 0, invalidations: 0 };

function remove(key) {
  const entry = entries.get(key);
  if (!entry) return;
  entries.delete(key);
  for (const tag of entry.tags) keysByTag.get(tag)?.delete(key);
}

function set(key, value, ttlMs, tags = []) {
  if (disabled() || ttlMs <= 0) return;
  remove(key);
  if (entries.size >= MAX_ENTRIES) {
    // Map keeps insertion order: drop the oldest tenth.
    const drop = Math.ceil(MAX_ENTRIES / 10);
    for (const oldKey of entries.keys()) {
      remove(oldKey);
      if (entries.size <= MAX_ENTRIES - drop) break;
    }
  }
  entries.set(key, { value, expires: Date.now() + ttlMs, tags });
  for (const tag of tags) {
    if (!keysByTag.has(tag)) keysByTag.set(tag, new Set());
    keysByTag.get(tag).add(key);
  }
}

function get(key) {
  const entry = entries.get(key);
  if (!entry) return undefined;
  if (entry.expires <= Date.now()) {
    remove(key);
    return undefined;
  }
  return entry.value;
}

// Per-tag write counters: a value computed while one of its tables was
// written is not stored afterwards (it may already be stale).
const tagVersions = new Map();
let clears = 0;
const versionsOf = (tags) => [clears, ...tags.map((tag) => tagVersions.get(tag) || 0)].join(",");

/**
 * Cached value for `key`, computing it with `load()` on a miss. Concurrent
 * misses for the same key share one `load()` call.
 */
async function wrap(key, ttlMs, tags, load) {
  if (disabled()) return load();
  const cached = get(key);
  if (cached !== undefined) {
    stats.hits += 1;
    return cached;
  }
  if (inFlight.has(key)) return inFlight.get(key);
  stats.misses += 1;
  const startedAt = versionsOf(tags);
  const promise = (async () => {
    try {
      const value = await load();
      if (versionsOf(tags) === startedAt && value !== undefined) set(key, value, ttlMs, tags);
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, promise);
  return promise;
}

/** Drop every entry built from any of these models (called after writes). */
function invalidateModels(models) {
  for (const model of models) {
    tagVersions.set(model, (tagVersions.get(model) || 0) + 1);
    const keys = keysByTag.get(model);
    if (!keys || !keys.size) continue;
    stats.invalidations += keys.size;
    for (const key of [...keys]) remove(key);
  }
}

function clear() {
  clears += 1;
  stats.invalidations += entries.size;
  entries.clear();
  keysByTag.clear();
}

/** Drop entries whose key starts with `prefix` (e.g. one user's responses). */
function removeByPrefix(prefix) {
  for (const key of [...entries.keys()]) if (key.startsWith(prefix)) remove(key);
}

/** Write counters of these tags now; pass the result to setIfUnchanged(). */
const snapshot = (tags) => versionsOf(tags);

/** set(), unless one of `tags` was written since `startedAt` (a snapshot(tags) value). */
function setIfUnchanged(startedAt, key, value, ttlMs, tags) {
  if (versionsOf(tags) === startedAt) set(key, value, ttlMs, tags);
}

const cacheStats = () => ({ entries: entries.size, ...stats, disabled: disabled() });

module.exports = { get, set, setIfUnchanged, snapshot, wrap, remove, removeByPrefix, invalidateModels, clear, cacheStats, disabled };
