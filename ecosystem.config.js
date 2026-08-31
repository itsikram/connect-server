// PM2: CPU load balancer on :4000 plus forked API backends on :4001+
const backendCount = Math.max(1, Number(process.env.LB_BACKENDS || 3));
const lbPort = Number(process.env.LB_PORT || 4000);
const backendStartPort = Number(process.env.LB_BACKEND_START_PORT || 4001);
const backendUrls = Array.from(
  { length: backendCount },
  (_, i) => `http://127.0.0.1:${backendStartPort + i}`,
);
const peerServers = backendUrls.join(",");

const apps = backendUrls.map((url, index) => {
  const port = backendStartPort + index;
  return {
    name: `connect-api-${port}`,
    script: "./index.js",
    instances: 1,
    exec_mode: "fork",
    watch: false,
    max_memory_restart: "1G",
    autorestart: true,
    max_restarts: 10,
    min_uptime: "10s",
    kill_timeout: 10000,
    env: {
      NODE_ENV: "production",
      PORT: port,
      RUN_WORKERS: index === 0 ? "1" : "0",
      INSTANCE_URL: url,
      PEER_SERVERS: peerServers,
    },
  };
});

apps.push({
  name: "connect-lb",
  script: "./load-balancer/index.js",
  instances: 1,
  exec_mode: "fork",
  watch: false,
  autorestart: true,
  max_restarts: 10,
  min_uptime: "10s",
  kill_timeout: 5000,
  env: {
    NODE_ENV: "production",
    LB_PORT: lbPort,
    BACKEND_SERVERS: peerServers,
  },
});

module.exports = { apps };
