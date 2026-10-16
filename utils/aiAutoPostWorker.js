const { prisma } = require("./db");
const { getConfig, generateAutoPost } = require("../services/aiAutoPostService");

let interval = null;
let running = false;

const startAiAutoPostWorker = () => {
  if (interval) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const config = await getConfig();
      if (!config.enabled || config.paused || !config.schedule.length) return;
      const now = new Date();
      let hhmm;
      try {
        const parts = new Intl.DateTimeFormat("en-GB", {
          timeZone: config.timezone || "UTC",
          hour: "2-digit",
          minute: "2-digit",
          hourCycle: "h23",
        }).formatToParts(now);
        const hour = parts.find((part) => part.type === "hour")?.value;
        const minute = parts.find((part) => part.type === "minute")?.value;
        hhmm = `${hour}:${minute}`;
      } catch (error) {
        console.warn("[ai-auto-post] invalid timezone, falling back to UTC:", config.timezone);
        hhmm = `${String(now.getUTCHours()).padStart(2, "0")}:${String(now.getUTCMinutes()).padStart(2, "0")}`;
      }
      if (!config.schedule.includes(hhmm)) return;
      const windowStart = new Date(Math.floor(Date.now() / 60000) * 60000);
      const claimed = await prisma.aIAutoPostConfig.updateMany({
        where: { singletonKey: "default", OR: [{ lastRunAt: null }, { lastRunAt: { not: windowStart } }] },
        data: { lastRunAt: windowStart },
      });
      if (!claimed.count) return;
      const today = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const count = await prisma.aIGeneratedPost.count({ where: { generatedAt: { gte: today }, status: { not: "failed" } } });
      if (count >= config.postsPerDay) return;
      await generateAutoPost({ config, publish: config.autoPublish });
    } catch (error) {
      console.error("[ai-auto-post] scheduled generation failed:", error?.message || error);
    } finally { running = false; }
  };
  interval = setInterval(tick, 60 * 1000);
  if (typeof interval.unref === "function") interval.unref();
  tick();
};

module.exports = { startAiAutoPostWorker };
