const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env") });
const dns = require("dns");
// Local DNS (e.g. 192.168.1.1) often refuses MongoDB SRV lookups → querySrv ECONNREFUSED.
// Prefer public resolvers so mongodb+srv:// still works if used.
try {
  dns.setServers(["8.8.8.8", "8.8.4.4", "1.1.1.1"]);
} catch (_) {
  /* ignore if unsupported */
}

const express = require("express");
const PORT = process.env.PORT || 4000;
const mongoose = require("mongoose");
const MONGODB_URI =
  process.env.NODE_ENV == "production"
    ? process.env.PROD_MONGODB_URI
    : process.env.DEV_MONGODB_URI;
mongoose.set("strictQuery", false);
mongoose.set("strictPopulate", false);
const socketIo = require("socket.io");
const { createServer } = require("http");
const cors = require("cors");
const middilewares = require("./middlewares/middlewares");
const routes = require("./Routes/routes");
const agoraRoutes = require("./Routes/agoraRoutes");
const ytDownloadRoutes = require("./Routes/ytDownloadRoutes");
let app = express();
app.set("trust proxy", 1);
const socketHandler = require("./sockets/socketHandler");
const { initializeSpeechWebSocketServer } = require("./speech/speechWsServer");
const httpServer = createServer(app);
const admin = require("firebase-admin");
const fs = require("fs");
const { startUnseenMessageReminderWorker } = require("./utils/unseenMessageReminderWorker");
const { startDailyPromptWorker } = require("./utils/dailyPromptWorker");
const { startCpuSampler, getMetrics } = require("./utils/cpuMetrics");
const {
  attachPeerAdapter,
  attachPeerRelayRoute,
} = require("./utils/peerSocketAdapter");
const isAuth = require("./middlewares/isAuth");
const { sendBump } = require("./controllers/messageController");
const {
  getCobaltConfig,
  applyCobaltUrl,
} = require("./utils/cobaltTunnelSync");
const {
  getFaceServiceConfig,
  applyFaceServiceUrl,
} = require("./utils/faceServiceSync");

const normalizeMultilineEnv = (value = "") =>
  String(value).replace(/\\n/g, "\n");

const getServiceAccountFromSplitEnv = () => {
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;

  if (!projectId || !privateKey || !clientEmail) {
    return null;
  }

  return {
    type: process.env.FIREBASE_TYPE || "service_account",
    project_id: projectId,
    private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
    private_key: normalizeMultilineEnv(privateKey),
    client_email: clientEmail,
    client_id: process.env.FIREBASE_CLIENT_ID,
    auth_uri:
      process.env.FIREBASE_AUTH_URI ||
      "https://accounts.google.com/o/oauth2/auth",
    token_uri:
      process.env.FIREBASE_TOKEN_URI || "https://oauth2.googleapis.com/token",
    auth_provider_x509_cert_url:
      process.env.FIREBASE_AUTH_PROVIDER_X509_CERT_URL ||
      "https://www.googleapis.com/oauth2/v1/certs",
    client_x509_cert_url: process.env.FIREBASE_CLIENT_X509_CERT_URL,
    universe_domain: process.env.FIREBASE_UNIVERSE_DOMAIN || "googleapis.com",
  };
};

/** Android google-services.json shape — not valid for GOOGLE_APPLICATION_CREDENTIALS / Admin SDK */
const isGoogleServicesClientJson = (obj) =>
  obj &&
  typeof obj === "object" &&
  obj.project_info &&
  Array.isArray(obj.client) &&
  obj.type !== "service_account";

const isServiceAccountKeyJson = (obj) =>
  obj &&
  typeof obj === "object" &&
  obj.type === "service_account" &&
  typeof obj.private_key === "string" &&
  typeof obj.client_email === "string";

const withNormalizedPrivateKey = (sa) => {
  if (!sa || typeof sa.private_key !== "string") return sa;
  return { ...sa, private_key: normalizeMultilineEnv(sa.private_key) };
};

/** Relative paths resolve next to this file (not process.cwd()), so .env can use `serviceAccountKeys.json`. */
const resolveCredentialsPathRelativeToServer = (p) => {
  if (!p || typeof p !== "string") return "";
  const stripped = p.replace(/^['"]|['"]$/g, "").trim();
  if (!stripped) return "";
  return path.isAbsolute(stripped) ? stripped : path.join(__dirname, stripped);
};

const loadServiceAccountFromEnvJson = () => {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  const trimmed = raw && typeof raw === "string" ? raw.trim() : "";
  if (trimmed) {
    try {
      const parsed = JSON.parse(trimmed);
      if (isServiceAccountKeyJson(parsed)) {
        return { ok: true, serviceAccount: withNormalizedPrivateKey(parsed) };
      }
      console.warn(
        "FIREBASE_SERVICE_ACCOUNT: JSON is not a valid service_account key (type, private_key, client_email).",
      );
    } catch (e) {
      console.warn(
        "FIREBASE_SERVICE_ACCOUNT JSON.parse failed:",
        e && e.message ? e.message : e,
        "— Dotenv only keeps the first line unless the whole value is one quoted block; use minified one-line JSON, FIREBASE_SERVICE_ACCOUNT_BASE64, GOOGLE_APPLICATION_CREDENTIALS=path, or serviceAccountKeys.json beside index.js.",
      );
    }
  }
  const b64 = process.env.FIREBASE_SERVICE_ACCOUNT_BASE64;
  if (b64 && String(b64).trim()) {
    try {
      const parsed = JSON.parse(
        Buffer.from(String(b64).trim(), "base64").toString("utf8"),
      );
      if (isServiceAccountKeyJson(parsed)) {
        return { ok: true, serviceAccount: withNormalizedPrivateKey(parsed) };
      }
      console.warn(
        "FIREBASE_SERVICE_ACCOUNT_BASE64: decoded JSON is not a valid service_account key.",
      );
    } catch (e) {
      console.warn(
        "FIREBASE_SERVICE_ACCOUNT_BASE64 decode/parse failed:",
        e && e.message ? e.message : e,
      );
    }
  }
  return { ok: false };
};

/**
 * GOOGLE_APPLICATION_CREDENTIALS: filesystem path to a service account key JSON, **or** the same
 * JSON as a single-line/multiline string in env (not google-services.json — that has no private key).
 */
const evaluateAdcCredentialsFile = (adcPath) => {
  if (!adcPath || !fs.existsSync(adcPath)) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(adcPath, "utf8"));
    if (isGoogleServicesClientJson(parsed)) {
      return { ok: false, issue: "google_services_client" };
    }
    if (!isServiceAccountKeyJson(parsed)) {
      return { ok: false, issue: "not_service_account" };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, issue: "parse_error", err: e };
  }
};

const logAdcFileProblems = (adcPath, evalResult) => {
  if (!evalResult || evalResult.ok || !evalResult.issue) {
    return;
  }
  if (evalResult.issue === "google_services_client") {
    console.warn(
      "GOOGLE_APPLICATION_CREDENTIALS points to google-services.json (Android client config). " +
        "That file has no private key. Use a service account JSON, or rely on FIREBASE_* env vars / serviceAccountKey.json.",
    );
  } else if (evalResult.issue === "not_service_account") {
    console.warn(
      "GOOGLE_APPLICATION_CREDENTIALS file is not a valid service account key JSON " +
        '(expected type "service_account", private_key, client_email). Skipping ADC path mode.',
    );
  } else if (evalResult.issue === "parse_error") {
    const e = evalResult.err;
    console.warn(
      "Could not read/parse GOOGLE_APPLICATION_CREDENTIALS file:",
      e && e.message ? e.message : e,
    );
  }
};

const evaluateAdcCredentialsJsonString = (raw) => {
  if (!raw || typeof raw !== "string" || !raw.trim().startsWith("{")) {
    return { ok: false };
  }
  try {
    const parsed = JSON.parse(raw.trim());
    if (isGoogleServicesClientJson(parsed)) {
      return { ok: false, issue: "google_services_client" };
    }
    if (!isServiceAccountKeyJson(parsed)) {
      return { ok: false, issue: "not_service_account" };
    }
    return { ok: true, serviceAccount: withNormalizedPrivateKey(parsed) };
  } catch (e) {
    return { ok: false, issue: "parse_error", err: e };
  }
};

const logAdcInlineJsonProblems = (evalResult) => {
  if (!evalResult || evalResult.ok || !evalResult.issue) {
    return;
  }
  if (evalResult.issue === "google_services_client") {
    console.warn(
      "GOOGLE_APPLICATION_CREDENTIALS is inline JSON but looks like google-services.json (Android client). " +
        "Admin SDK needs a service account key JSON. Use FIREBASE_SERVICE_ACCOUNT or paste the service account JSON here.",
    );
  } else if (evalResult.issue === "not_service_account") {
    console.warn(
      "GOOGLE_APPLICATION_CREDENTIALS inline JSON is not a valid service account key " +
        '(expected type "service_account", private_key, client_email). Skipping inline JSON mode.',
    );
  } else if (evalResult.issue === "parse_error") {
    const e = evalResult.err;
    console.warn(
      "Could not parse GOOGLE_APPLICATION_CREDENTIALS as JSON:",
      e && e.message ? e.message : e,
    );
  }
};

/** Ensures app.options.projectId is set for logs and client libs (cert-only init can leave it unset). */
const firebaseAppOptionsFromServiceAccount = (serviceAccount) => {
  const sa = withNormalizedPrivateKey(serviceAccount);
  const opts = { credential: admin.credential.cert(sa) };
  if (sa.project_id && String(sa.project_id).trim()) {
    opts.projectId = String(sa.project_id).trim();
  }
  return opts;
};

// Initialize Firebase Admin using proper server credentials
// Order: GOOGLE_APPLICATION_CREDENTIALS (inline service account JSON or file path / ADC),
// FIREBASE_SERVICE_ACCOUNT (JSON string), split FIREBASE_* env, serviceAccountKey.json.
try {
  const adcPathRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const adcLooksLikeJson =
    typeof adcPathRaw === "string" && adcPathRaw.trim().startsWith("{");
  const adcPathResolved =
    adcPathRaw && !adcLooksLikeJson
      ? resolveCredentialsPathRelativeToServer(adcPathRaw)
      : "";
  const adcPathExists = adcPathResolved
    ? fs.existsSync(adcPathResolved)
    : false;

  let adcJsonEval = { ok: false };
  if (adcLooksLikeJson && adcPathRaw) {
    adcJsonEval = evaluateAdcCredentialsJsonString(adcPathRaw);
    logAdcInlineJsonProblems(adcJsonEval);
  } else if (adcPathRaw && !adcLooksLikeJson && !adcPathExists) {
    console.warn(
      `GOOGLE_APPLICATION_CREDENTIALS path not found: ${adcPathResolved || adcPathRaw}. Skipping file mode.`,
    );
  }

  const splitServiceAccount = getServiceAccountFromSplitEnv();

  let adcFileEval = { ok: false };
  if (adcPathRaw && !adcLooksLikeJson && adcPathExists) {
    adcFileEval = evaluateAdcCredentialsFile(adcPathResolved);
    logAdcFileProblems(adcPathResolved, adcFileEval);
  }

  const useAdcFile = adcFileEval.ok;

  if (admin.apps.length === 0) {
    if (adcJsonEval.ok && adcJsonEval.serviceAccount) {
      admin.initializeApp(
        firebaseAppOptionsFromServiceAccount(adcJsonEval.serviceAccount),
      );
    } else if (useAdcFile) {
      const fileJson = JSON.parse(fs.readFileSync(adcPathResolved, "utf8"));
      admin.initializeApp(firebaseAppOptionsFromServiceAccount(fileJson));
    } else {
      const envSa = loadServiceAccountFromEnvJson();
      if (envSa.ok && envSa.serviceAccount) {
        admin.initializeApp(
          firebaseAppOptionsFromServiceAccount(envSa.serviceAccount),
        );
      } else if (splitServiceAccount) {
        admin.initializeApp(
          firebaseAppOptionsFromServiceAccount(splitServiceAccount),
        );
      } else {
        let serviceAccount = null;
        for (const name of [
          "serviceAccountKey.json",
          "serviceAccountKeys.json",
        ]) {
          const saPath = path.join(__dirname, name);
          if (fs.existsSync(saPath)) {
            serviceAccount = require(saPath);
            break;
          }
        }
        if (serviceAccount) {
          admin.initializeApp(
            firebaseAppOptionsFromServiceAccount(serviceAccount),
          );
        } else {
          admin.initializeApp();
          console.warn(
            "Firebase Admin initialized without explicit credentials. Set GOOGLE_APPLICATION_CREDENTIALS, FIREBASE_SERVICE_ACCOUNT, FIREBASE_SERVICE_ACCOUNT_BASE64, or add serviceAccountKeys.json beside index.js.",
          );
        }
      }
    }
  }
} catch (err) {
  console.error(
    "Failed to initialize Firebase Admin:",
    err && err.message ? err.message : err,
  );
}

// Firebase + Google Cloud connection status logs
const logFirebaseAndGoogleCloudStatus = async () => {
  const saKeyPath = path.join(__dirname, "serviceAccountKey.json");
  const saKeysPath = path.join(__dirname, "serviceAccountKeys.json");

  const adcPathRaw = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const adcLooksLikeJson =
    typeof adcPathRaw === "string" && adcPathRaw.trim().startsWith("{");
  const adcPathResolved =
    adcPathRaw && !adcLooksLikeJson
      ? resolveCredentialsPathRelativeToServer(adcPathRaw)
      : "";
  const adcPathExists = adcPathResolved
    ? fs.existsSync(adcPathResolved)
    : false;
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT;
  const splitServiceAccount = getServiceAccountFromSplitEnv();

  const adcJsonEvalForLog =
    adcLooksLikeJson && adcPathRaw
      ? evaluateAdcCredentialsJsonString(adcPathRaw)
      : { ok: false };
  const adcFileEvalForLog =
    adcPathRaw && !adcLooksLikeJson && adcPathExists
      ? evaluateAdcCredentialsFile(adcPathResolved)
      : { ok: false };

  const hasLocalSaFile = fs.existsSync(saKeyPath) || fs.existsSync(saKeysPath);

  const credentialSource = adcJsonEvalForLog.ok
    ? "GOOGLE_APPLICATION_CREDENTIALS (inline JSON)"
    : adcFileEvalForLog.ok
      ? "GOOGLE_APPLICATION_CREDENTIALS (file)"
      : process.env.FIREBASE_SERVICE_ACCOUNT_BASE64
        ? "FIREBASE_SERVICE_ACCOUNT_BASE64"
        : process.env.FIREBASE_SERVICE_ACCOUNT
          ? "FIREBASE_SERVICE_ACCOUNT (env JSON)"
          : splitServiceAccount
            ? "FIREBASE_* split env vars"
            : hasLocalSaFile
              ? "serviceAccountKey(s).json (local file)"
              : "default/ADC (unspecified)";

  const appsCount = admin.apps?.length ?? 0;
  const app0 = admin.apps?.[0];
  let projectId = app0?.options?.projectId || "unknown";
  if (
    projectId === "unknown" &&
    adcJsonEvalForLog.ok &&
    adcJsonEvalForLog.serviceAccount?.project_id
  ) {
    projectId = adcJsonEvalForLog.serviceAccount.project_id;
  }
  if (projectId === "unknown" && serviceAccountJson) {
    try {
      const parsed = JSON.parse(serviceAccountJson);
      if (parsed && parsed.project_id) {
        projectId = parsed.project_id;
      }
    } catch (e) {}
  }
  if (projectId === "unknown" && splitServiceAccount?.project_id) {
    projectId = splitServiceAccount.project_id;
  }
  if (projectId === "unknown" && adcFileEvalForLog.ok && adcPathResolved) {
    try {
      const fromFile = JSON.parse(fs.readFileSync(adcPathResolved, "utf8"));
      if (fromFile && fromFile.project_id) {
        projectId = fromFile.project_id;
      }
    } catch (e) {}
  }

  console.log(
    `[firebase] Admin init status: apps=${appsCount}, credentialSource=${credentialSource}, projectId=${projectId}`,
  );

  // Optional live Google Cloud connectivity check
  if (process.env.CHECK_GOOGLE_CLOUD_ON_STARTUP === "true" && appsCount > 0) {
    try {
      await admin.firestore().listCollections();
      console.log("[google-cloud] Firestore connectivity check: OK");
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      const code = e && e.code;
      console.error("[google-cloud] Firestore connectivity check: FAILED", msg);
      if (code === 5 || /NOT_FOUND/i.test(msg)) {
        console.error(
          "[google-cloud] NOT_FOUND usually means no Firestore database exists yet. Firebase Console → Build → Firestore Database → create database. If you only need FCM, set CHECK_GOOGLE_CLOUD_ON_STARTUP=false in .env.",
        );
      }
    }
  } else {
    console.log(
      "[google-cloud] Firestore connectivity check: skipped (set CHECK_GOOGLE_CLOUD_ON_STARTUP=true to enable)",
    );
  }
};

logFirebaseAndGoogleCloudStatus().catch((e) => {
  console.error(
    "[firebase/google-cloud] Status logger failed:",
    e && e.message ? e.message : e,
  );
});

// Enable pre-flight requests
app.options("*", cors());

// Configure CORS
app.use(
  cors({
    origin: true, // Allow all origins temporarily for debugging
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
    exposedHeaders: ["Content-Range", "X-Content-Range"],
  }),
);

// Additional headers for CORS
app.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.header(
    "Access-Control-Allow-Headers",
    "Content-Type, Authorization, Content-Length, X-Requested-With, Accept, Origin",
  );
  res.header("Access-Control-Allow-Credentials", "true");
  if ("OPTIONS" === req.method) {
    res.sendStatus(200);
  } else {
    next();
  }
});

const io = socketIo(httpServer, {
  cors: {
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    credentials: true,
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "X-Requested-With",
      "Accept",
      "Origin",
    ],
  },
  allowEIO3: true,
  transports: ["websocket", "polling"],
  pingTimeout: 60000,
  pingInterval: 25000,
  path: "/socket.io",
  cookie: false,
});

global.io = io;

socketHandler(io);
initializeSpeechWebSocketServer(httpServer);
startCpuSampler();
attachPeerAdapter(io);

// Setting up middilewares
middilewares(app);

app.get("/health", (req, res) => {
  res.json(getMetrics({ io }));
});
app.get("/api/health", (req, res) => {
  res.json(getMetrics({ io }));
});

app.get("/api/youtube/cobalt-config", (req, res) => {
  res.json(getCobaltConfig());
});

app.post("/api/youtube/cobalt-url", (req, res) => {
  const expectedSecret = String(
    process.env.COBALT_SYNC_SECRET || process.env.COBALT_API_KEY || "",
  ).trim();
  const incomingSecret = String(
    req.headers["x-cobalt-sync-secret"] ||
      req.headers.authorization ||
      req.body?.secret ||
      "",
  )
    .replace(/^Bearer\s+/i, "")
    .replace(/^Api-Key\s+/i, "")
    .trim();

  if (expectedSecret && incomingSecret !== expectedSecret) {
    return res.status(401).json({
      ok: false,
      error: "Invalid cobalt sync secret",
    });
  }

  const url = String(req.body?.url || req.query?.url || "").trim();
  const result = applyCobaltUrl(url, "home-cobalt-sync");
  if (!result.ok) {
    return res.status(400).json({ ok: false, error: result.error });
  }

  if (io) {
    io.emit("youtube-cobalt-url", getCobaltConfig());
  }

  return res.json({ ok: true, ...getCobaltConfig() });
});

app.get("/api/face-service-config", (req, res) => {
  res.json(getFaceServiceConfig());
});

app.post("/api/face-service-url", (req, res) => {
  const expectedSecret = String(
    process.env.FACE_SYNC_SECRET || process.env.COBALT_SYNC_SECRET || process.env.COBALT_API_KEY || "",
  ).trim();
  const incomingSecret = String(
    req.headers["x-face-sync-secret"] || req.headers.authorization || req.body?.secret || "",
  )
    .replace(/^Bearer\s+/i, "")
    .replace(/^Api-Key\s+/i, "")
    .trim();

  if (expectedSecret && incomingSecret !== expectedSecret) {
    return res.status(401).json({ ok: false, error: "Invalid face sync secret" });
  }

  const result = applyFaceServiceUrl(req.body?.url || req.query?.url, "home-face-sync");
  if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
  return res.json(result);
});

attachPeerRelayRoute(app, io);

// setting up routes
routes(app);

app.post("/api/bump", isAuth, sendBump);

// YouTube download service (Node.js ytdl-core)
app.use(ytDownloadRoutes);

// setup Agora routes
app.use("/api/agora", agoraRoutes);

app.set("io", io);

// Middleware to disable caching for localhost
app.use((req, res, next) => {
  const hostname = req.hostname || req.get("host")?.split(":")[0];
  const isLocalhost =
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]";

  if (isLocalhost) {
    res.set({
      "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
      Pragma: "no-cache",
      Expires: "0",
    });
  }
  next();
});

app.use(
  express.static(path.join(__dirname, "build"), {
    setHeaders: (res, filePath, stat) => {
      // Safari only offers Settings → Profile Downloaded with this MIME type
      if (filePath && filePath.endsWith(".mobileconfig")) {
        res.setHeader("Content-Type", "application/x-apple-aspen-config");
        res.setHeader(
          "Content-Disposition",
          'inline; filename="connect.mobileconfig"',
        );
      }
      // For static files, check if request is from localhost via the middleware above
      // This will be set by the middleware, so we check if headers are already set
      // If not set, add no-cache headers as a safety measure
      if (!res.get("Cache-Control")) {
        res.set({
          "Cache-Control":
            "no-store, no-cache, must-revalidate, proxy-revalidate",
          Pragma: "no-cache",
          Expires: "0",
        });
      }
    },
  }),
);

// Also expose profile from server/public with correct MIME (API origin)
app.get("/connect.mobileconfig", (req, res) => {
  const filePath = path.join(__dirname, "public", "connect.mobileconfig");
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("iOS profile not found");
  }
  res.setHeader("Content-Type", "application/x-apple-aspen-config");
  res.setHeader(
    "Content-Disposition",
    'inline; filename="connect.mobileconfig"',
  );
  res.setHeader("Cache-Control", "no-store");
  return res.sendFile(filePath);
});

// Test FCM to one Android device: GET /fcm?token=...&title=...&body=...
// Or set TEST_FCM_TOKEN in .env and call GET /fcm (no token in URL).

// app.get('*', (req, res) => {
//   const hostname = req.hostname || req.get('host')?.split(':')[0];
//   const isLocalhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';

//   if (isLocalhost) {
//     res.set({
//       'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
//       'Pragma': 'no-cache',
//       'Expires': '0'
//     });
//   }

//   // res.sendFile(path.join(__dirname, 'build', 'index.html'));
//   return res.json({ message: 'working fine' });
// });

app.get("/fcm", async (req, res) => {
  const token =
    (req.query.token && String(req.query.token).trim()) ||
    (process.env.TEST_FCM_TOKEN || "").trim();
  if (!token) {
    return res.status(400).json({
      ok: false,
      pushStatus: "missing_token",
      error:
        "Missing push token. Pass ?token=... (FCM registration token or ExponentPushToken[...]) or set TEST_FCM_TOKEN in .env.",
    });
  }

  const title = (req.query.title && String(req.query.title)) || "Test";
  const body = (req.query.body && String(req.query.body)) || "Working 🎉";

  try {
    const { sendPushToTokens } = require("./utils/pushNotifications");
    const result = await sendPushToTokens([token], {
      title,
      body,
      data: { type: "test" },
      channelId: String(req.query.channelId || "default"),
    });
    return res.status(200).json({
      ok: true,
      pushStatus: "sent",
      ...result,
      title,
      body,
      sentAt: new Date().toISOString(),
    });
  } catch (err) {
    const code = err && err.code;
    const message = err && err.message ? err.message : String(err);
    const errorInfo = err && err.errorInfo ? err.errorInfo : undefined;
    console.error("[fcm] /fcm test send failed:", code, message);
    return res.status(502).json({
      ok: false,
      pushStatus: "failed",
      error: message,
      code: code || undefined,
      ...(errorInfo ? { errorInfo } : {}),
    });
  }
});

// app.get('/', async (req, res) => {
//   return res.json({ message: 'workign fine' });
// })

// Root route should serve index.html

const mongoUri =
  process.env.PROD_MONGODB_URI || process.env.MONGODB_URI || MONGODB_URI;
mongoose
  .connect(mongoUri, {
    serverSelectionTimeoutMS: 20000,
    family: 4, // prefer IPv4 — avoids flaky IPv6 on some local networks
  })
  .then(() => {
    console.log("MongoDB connected");
    const runWorkers =
      process.env.RUN_WORKERS !== "0" &&
      process.env.RUN_WORKERS !== "false" &&
      process.env.DISABLE_WORKERS !== "1" &&
      process.env.DISABLE_WORKERS !== "true";
    if (runWorkers) {
      startUnseenMessageReminderWorker();
      startDailyPromptWorker();
    } else {
      console.log("Background workers skipped on this instance");
    }
  })
  .catch((e) => {
    console.error(
      "MongoDB connection failed — server will still start, but DB features may not work:",
      e.message || e,
    );
  });

httpServer.listen(PORT, "0.0.0.0", () => {
  const { isCursorConfigured } = require("./utils/cursorAgentClient");
  console.log(`Server is running on port ${PORT}`);
  console.log(
    `Cursor Cloud Agents: ${isCursorConfigured() ? "key loaded from server/.env" : "CURSOR_API_KEY missing"}`,
  );
  if (typeof process.send === "function") {
    process.send("ready");
  }
});
