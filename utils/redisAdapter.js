/**
 * Socket.IO Redis adapter — lets several Connect servers (e.g. multiple
 * Render services) share rooms, so io.to(profileId).emit(...) reaches the
 * user whichever server their socket is connected to.
 *
 * Enabled only when REDIS_URL is set; without it the server runs standalone
 * exactly as before.
 */
const { createAdapter } = require("@socket.io/redis-adapter");
const { createClient } = require("redis");
const { connectSharedMaps } = require("./sharedMap");

async function attachRedisAdapter(io) {
  const url = String(process.env.REDIS_URL || "").trim();
  if (!url) {
    console.log("[socket] REDIS_URL not set — single-server mode");
    return false;
  }

  try {
    const pubClient = createClient({
      url,
      socket: {
        // Give up after ~10 tries on startup/outage instead of spamming logs.
        reconnectStrategy: (retries) =>
          retries > 10 ? new Error("Redis unreachable") : Math.min(retries * 500, 5000),
      },
    });
    const subClient = pubClient.duplicate();
    pubClient.on("error", (err) => console.error("[redis pub]", err.message));
    subClient.on("error", (err) => console.error("[redis sub]", err.message));

    await Promise.all([pubClient.connect(), subClient.connect()]);
    io.adapter(createAdapter(pubClient, subClient));
    console.log("[socket] Redis adapter attached — multi-server mode");
    // Share chess/ludo game state between servers too.
    connectSharedMaps(pubClient).catch((err) =>
      console.error("[sharedMap] connect failed:", err.message),
    );
    return true;
  } catch (err) {
    console.error("[socket] Redis adapter failed, staying single-server:", err.message);
    return false;
  }
}

module.exports = { attachRedisAdapter };
