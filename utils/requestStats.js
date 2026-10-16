// Per-request database stats: how many Prisma queries a request ran and how
// long they took. Enabled with QUERY_STATS=1; the numbers go out in a
// `Server-Timing` header (app;dur=..., db;dur=...;desc="N queries") and, for
// slow requests, to the log.
const { AsyncLocalStorage } = require("async_hooks");

const storage = new AsyncLocalStorage();
const enabled = () => process.env.QUERY_STATS === "1";
const SLOW_MS = Number(process.env.QUERY_STATS_SLOW_MS) || 300;

/** Called by the Prisma client extension around every query. */
function recordQuery(ms) {
  const stats = storage.getStore();
  if (!stats) return;
  stats.queries += 1;
  stats.dbMs += ms;
}

function requestStatsMiddleware(req, res, next) {
  if (!enabled()) return next();
  const stats = { queries: 0, dbMs: 0, start: performance.now() };
  const writeHead = res.writeHead;
  res.writeHead = function patchedWriteHead(...args) {
    const total = performance.now() - stats.start;
    if (!res.headersSent) {
      res.setHeader(
        "Server-Timing",
        `app;dur=${total.toFixed(1)}, db;dur=${stats.dbMs.toFixed(1)};desc="${stats.queries} queries"`,
      );
    }
    if (total >= SLOW_MS) {
      console.log(`[query-stats] ${req.method} ${req.originalUrl} ${total.toFixed(0)}ms, ${stats.queries} queries, db ${stats.dbMs.toFixed(0)}ms`);
    }
    return writeHead.apply(this, args);
  };
  return storage.run(stats, next);
}

module.exports = { recordQuery, requestStatsMiddleware };
