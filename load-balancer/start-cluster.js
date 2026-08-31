/**
 * Starts N API processes plus the CPU load balancer.
 * Usage: node load-balancer/start-cluster.js [backendCount]
 *
 * Clients keep using PORT 4000 (the balancer). Backends bind 4001+.
 */
const path = require("path");
const { spawn } = require("child_process");

require("dotenv").config({ path: path.join(__dirname, "..", ".env") });

const serverRoot = path.join(__dirname, "..");
const backendCount = Math.max(
  1,
  Number(process.argv[2] || process.env.LB_BACKENDS || 3),
);
// Render injects PORT (often 10000). Bind the public balancer there.
// API workers always use internal 4001+ so they never steal the public port.
const lbPort = Number(process.env.LB_PORT || process.env.PORT || 4000);
const backendStartPort = Number(process.env.LB_BACKEND_START_PORT || 4001);

const backendUrls = Array.from(
  { length: backendCount },
  (_, i) => `http://127.0.0.1:${backendStartPort + i}`,
);
const peerServers = backendUrls.join(",");
const children = new Map();
let shuttingDown = false;

const prefixLines = (label, chunk, write) => {
  const text = chunk.toString();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line && i === lines.length - 1) continue;
    write(`[${label}] ${line}\n`);
  }
};

const spawnChild = (label, script, extraEnv) => {
  const start = () => {
    if (shuttingDown) return;
    const child = spawn(process.execPath, [script], {
      cwd: serverRoot,
      env: {
        ...process.env,
        ...extraEnv,
      },
      stdio: ["inherit", "pipe", "pipe"],
      windowsHide: true,
    });

    children.set(label, child);
    child.stdout.on("data", (chunk) =>
      prefixLines(label, chunk, (line) => process.stdout.write(line)),
    );
    child.stderr.on("data", (chunk) =>
      prefixLines(label, chunk, (line) => process.stderr.write(line)),
    );
    child.on("exit", (code, signal) => {
      children.delete(label);
      if (shuttingDown) return;
      console.error(
        `[cluster] ${label} exited code=${code} signal=${signal || ""} — restarting in 2s`,
      );
      setTimeout(start, 2000).unref();
    });
  };

  start();
};

const stopAll = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children.values()) {
    if (!child.pid) continue;
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
          stdio: "ignore",
          windowsHide: true,
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch (_) {
      /* ignore */
    }
  }
  setTimeout(() => process.exit(0), 1500).unref();
};

process.on("SIGINT", stopAll);
process.on("SIGTERM", stopAll);

console.log(
  `[cluster] load balancer :${lbPort} → ${backendCount} backend(s) on ${backendUrls.join(", ")}`,
);

backendUrls.forEach((url, index) => {
  const port = backendStartPort + index;
  spawnChild(`api:${port}`, "index.js", {
    PORT: String(port),
    RUN_WORKERS: index === 0 ? "1" : "0",
    INSTANCE_URL: url,
    PEER_SERVERS: peerServers,
  });
});

spawnChild("lb", path.join("load-balancer", "index.js"), {
  PORT: String(lbPort),
  LB_PORT: String(lbPort),
  BACKEND_SERVERS: peerServers,
  LB_BACKENDS: String(backendCount),
  LB_BACKEND_START_PORT: String(backendStartPort),
});
