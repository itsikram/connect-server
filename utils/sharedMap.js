/**
 * SharedMap — a Map that is replicated across every Connect server via Redis.
 *
 * Game sockets (chess, ludo) keep their state in plain Maps and mutate the
 * objects they read synchronously (`games.get(id).fen = ...`). SharedMap keeps
 * that code unchanged:
 *   - every server holds a full local copy, so reads stay synchronous;
 *   - any key that is read or written is marked "touched"; after the current
 *     handler finishes (microtask) touched entries are re-serialized and, if
 *     they changed, saved to a Redis hash and broadcast to the other servers;
 *   - updates from other servers are applied in place, so object references
 *     held by running code stay valid;
 *   - on startup the server loads the current state from Redis.
 *
 * Without Redis (REDIS_URL unset) it is just a Map. Concurrent edits of the
 * same entry on two servers resolve as last-write-wins, which is fine for
 * turn-based games.
 */
const crypto = require("crypto");

const ORIGIN = crypto.randomBytes(8).toString("hex");
const CHANNEL = "connect:sharedmap";
const KEY_PREFIX = "connect:sharedmap:";
const TTL_SECONDS = 7 * 24 * 60 * 60;

const registry = new Map(); // name -> SharedMap
let redis = null; // command client, set once connected

const replacer = (_key, value) => {
  if (value instanceof Set) return { __t: "Set", v: Array.from(value) };
  if (value instanceof Map) return { __t: "Map", v: Array.from(value.entries()) };
  return value;
};

const reviver = (_key, value) => {
  if (value && typeof value === "object" && value.__t) {
    if (value.__t === "Set") return new Set(value.v);
    if (value.__t === "Map") return new Map(value.v);
  }
  return value;
};

const serialize = (value) => JSON.stringify(value, replacer);
const deserialize = (raw) => JSON.parse(raw, reviver);

const isPlainObject = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) &&
  !(v instanceof Set) && !(v instanceof Map);

class SharedMap extends Map {
  constructor(name) {
    super();
    this.name = name;
    this._touched = new Set();
    this._lastSaved = new Map(); // key -> serialized string
    this._flushQueued = false;
    if (registry.has(name)) throw new Error(`SharedMap "${name}" already exists`);
    registry.set(name, this);
  }

  _touch(key) {
    if (!redis) return;
    this._touched.add(key);
    if (!this._flushQueued) {
      this._flushQueued = true;
      queueMicrotask(() => this._flush());
    }
  }

  _touchAll() {
    if (!redis) return;
    for (const key of super.keys()) this._touch(key);
  }

  get(key) {
    const value = super.get(key);
    if (value !== undefined) this._touch(key);
    return value;
  }

  set(key, value) {
    super.set(key, value);
    this._touch(key);
    return this;
  }

  delete(key) {
    const had = super.delete(key);
    if (had) this._touch(key);
    return had;
  }

  clear() {
    const keys = Array.from(super.keys());
    super.clear();
    keys.forEach((k) => this._touch(k));
  }

  forEach(cb, thisArg) {
    this._touchAll();
    return super.forEach(cb, thisArg);
  }

  values() {
    this._touchAll();
    return super.values();
  }

  entries() {
    this._touchAll();
    return super.entries();
  }

  [Symbol.iterator]() {
    return this.entries();
  }

  async _flush() {
    this._flushQueued = false;
    if (!redis) return;
    const keys = Array.from(this._touched);
    this._touched.clear();
    const hashKey = KEY_PREFIX + this.name;

    for (const key of keys) {
      const k = String(key);
      try {
        if (!super.has(key)) {
          if (!this._lastSaved.has(k)) continue;
          this._lastSaved.delete(k);
          await redis.hDel(hashKey, k);
          await redis.publish(CHANNEL, JSON.stringify({ o: ORIGIN, m: this.name, k, d: true }));
          continue;
        }
        const data = serialize(super.get(key));
        if (this._lastSaved.get(k) === data) continue;
        this._lastSaved.set(k, data);
        await redis.hSet(hashKey, k, data);
        await redis.expire(hashKey, TTL_SECONDS);
        await redis.publish(CHANNEL, JSON.stringify({ o: ORIGIN, m: this.name, k, v: data }));
      } catch (err) {
        console.error(`[sharedMap:${this.name}] sync failed for ${k}:`, err.message);
      }
    }
  }

  // Apply a value that came from Redis without re-broadcasting it.
  _applyRemote(k, raw, deleted) {
    if (deleted) {
      this._lastSaved.delete(k);
      super.delete(k);
      return;
    }
    this._lastSaved.set(k, raw);
    const incoming = deserialize(raw);
    const current = super.get(k);
    if (isPlainObject(current) && isPlainObject(incoming)) {
      Object.keys(current).forEach((prop) => {
        if (!(prop in incoming)) delete current[prop];
      });
      Object.assign(current, incoming);
    } else {
      super.set(k, incoming);
    }
  }

  async _load() {
    const all = await redis.hGetAll(KEY_PREFIX + this.name);
    Object.entries(all || {}).forEach(([k, raw]) => {
      try {
        if (!super.has(k)) this._applyRemote(k, raw, false);
      } catch (_e) { /* skip corrupt entry */ }
    });
    // Publish anything created locally before Redis was ready.
    this._touchAll();
  }
}

/**
 * Called once the Redis adapter is connected. `client` is a connected
 * node-redis v4 client used for commands; a duplicate is made to subscribe.
 */
async function connectSharedMaps(client) {
  redis = client;
  const sub = client.duplicate();
  sub.on("error", (err) => console.error("[sharedMap sub]", err.message));
  await sub.connect();
  await sub.subscribe(CHANNEL, (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.o === ORIGIN) return;
      const map = registry.get(msg.m);
      if (map) map._applyRemote(msg.k, msg.v, msg.d);
    } catch (_e) { /* ignore malformed */ }
  });
  for (const map of registry.values()) {
    try {
      await map._load();
    } catch (err) {
      console.error(`[sharedMap:${map.name}] load failed:`, err.message);
    }
  }
  console.log(`[sharedMap] synced ${registry.size} map(s) via Redis`);
}

module.exports = { SharedMap, connectSharedMaps };
