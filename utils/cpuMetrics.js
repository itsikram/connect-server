const os = require("os");

let lastIdle = 0;
let lastTotal = 0;
let lastProc = process.cpuUsage();
let lastHr = process.hrtime.bigint();
let processCpuPercent = 0;
let systemCpuPercent = 0;
let sampledAt = 0;
let samplerStarted = false;

const readSystemCpu = () => {
  const cpus = os.cpus() || [];
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu.times || {};
    idle += Number(times.idle) || 0;
    total +=
      (Number(times.user) || 0) +
      (Number(times.nice) || 0) +
      (Number(times.sys) || 0) +
      (Number(times.idle) || 0) +
      (Number(times.irq) || 0);
  }
  return { idle, total, cores: cpus.length || 1 };
};

const sample = () => {
  const sys = readSystemCpu();
  if (lastTotal > 0) {
    const idleDiff = sys.idle - lastIdle;
    const totalDiff = sys.total - lastTotal;
    systemCpuPercent =
      totalDiff > 0
        ? Math.max(0, Math.min(100, (1 - idleDiff / totalDiff) * 100))
        : 0;
  }
  lastIdle = sys.idle;
  lastTotal = sys.total;

  const usage = process.cpuUsage();
  const hr = process.hrtime.bigint();
  const elapsedUs = Number(hr - lastHr) / 1000;
  const cpuUs =
    usage.user - lastProc.user + (usage.system - lastProc.system);
  processCpuPercent =
    elapsedUs > 0 ? Math.max(0, Math.min(100 * sys.cores, (cpuUs / elapsedUs) * 100)) : 0;
  lastProc = usage;
  lastHr = hr;
  sampledAt = Date.now();
};

const startCpuSampler = (intervalMs = 1000) => {
  if (samplerStarted) return;
  samplerStarted = true;
  sample();
  const timer = setInterval(sample, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
};

const getMetrics = ({ io } = {}) => {
  const mem = process.memoryUsage();
  return {
    ok: true,
    pid: process.pid,
    port: Number(process.env.PORT) || 4000,
    uptime: Math.round(process.uptime()),
    cpu: Math.round(processCpuPercent * 10) / 10,
    systemCpu: Math.round(systemCpuPercent * 10) / 10,
    memory: {
      rss: mem.rss,
      heapUsed: mem.heapUsed,
    },
    sockets: io && io.engine ? io.engine.clientsCount : 0,
    sampledAt,
  };
};

module.exports = {
  startCpuSampler,
  getMetrics,
};
