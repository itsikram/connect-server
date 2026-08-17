const fs = require("fs");
const path = require("path");
const axios = require("axios");
const { pipeline } = require("stream/promises");

/**
 * Cobalt API fallback when yt-dlp is blocked on cloud IPs.
 * Set COBALT_API_URL to your instance (recommended).
 * Optional: COBALT_API_KEY for Authorization: Api-Key / Bearer.
 */
const getCobaltInstances = () => {
  const primary = process.env.COBALT_API_URL;
  const fallback = !primary ? "https://api.cobalt.tools" : null;
  return [
    ...new Set(
      [primary, fallback].filter(Boolean).map((u) => u.replace(/\/$/, "")),
    ),
  ];
};

const isRemoteHomeCobalt = () => {
  const u = process.env.COBALT_API_URL || "";
  return u.startsWith("http") && !/localhost|127\.0\.0\.1/i.test(u);
};

const cobaltApiTimeoutMs = () =>
  Number(process.env.COBALT_API_TIMEOUT_MS) ||
  (isRemoteHomeCobalt() ? 180000 : 120000);

const cobaltMediaTimeoutMs = () =>
  Number(process.env.COBALT_MEDIA_TIMEOUT_MS) ||
  (isRemoteHomeCobalt() ? 600000 : 360000);

const heightToQuality = (height) => {
  if (!height) return "1080";
  const allowed = [144, 240, 360, 480, 720, 1080, 1440, 2160, 4320];
  const match = allowed.find((q) => q >= height) || allowed[allowed.length - 1];
  // Prefer exact or next-lower for speed on free tier
  const lower = [...allowed].reverse().find((q) => q <= height);
  return String(lower || match);
};

const cobaltHeaders = () => {
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/json",
    "User-Agent": "Connect-Server/1.0",
  };
  const key = process.env.COBALT_API_KEY;
  if (key) {
    headers.Authorization =
      key.startsWith("Bearer ") || key.startsWith("Api-Key ")
        ? key
        : `Api-Key ${key}`;
  }
  return headers;
};

const resolveDownloadUrl = (data) => {
  if (!data || typeof data !== "object") return null;
  if (data.status === "error") return null;
  if (data.url) return data.url;
  if (data.tunnel) return data.tunnel;
  if (Array.isArray(data.picker) && data.picker[0]?.url)
    return data.picker[0].url;
  return null;
};

const requestCobalt = async (baseUrl, youtubeUrl, height, extras = {}) => {
  const endpoint = baseUrl.replace(/\/$/, "") + "/";
  const { videoQuality, ...rest } = extras;
  const body = {
    url: youtubeUrl,
    downloadMode: "auto",
    videoQuality: videoQuality || heightToQuality(height),
    youtubeVideoCodec: "h264",
    youtubeVideoContainer: "mp4",
    youtubeBetterAudio: true,
    filenameStyle: "basic",
    alwaysProxy: true,
    ...rest,
  };

  if (body.downloadMode === "audio" && !body.audioFormat) {
    body.audioFormat = "mp3";
  }

  const res = await axios.post(endpoint, body, {
    headers: cobaltHeaders(),
    timeout: cobaltApiTimeoutMs(),
    validateStatus: () => true,
  });

  if (res.status >= 400 || res.data?.status === "error") {
    const msg =
      res.data?.error?.code ||
      res.data?.text ||
      res.data?.error ||
      `HTTP ${res.status}`;
    throw new Error(
      `Cobalt ${endpoint} error: ${typeof msg === "object" ? JSON.stringify(msg) : msg}`,
    );
  }

  const mediaUrl = resolveDownloadUrl(res.data);
  if (!mediaUrl) {
    throw new Error(
      `Cobalt returned no media URL (${res.data?.status || res.status})`,
    );
  }

  return {
    mediaUrl,
    filename: res.data?.filename || null,
    title: res.data?.filename
      ? String(res.data.filename).replace(/\.[^.]+$/, "")
      : "video",
    status: res.data?.status || null,
  };
};

const downloadFileFromUrl = async (mediaUrl, destPath, onProgress) => {
  let heartbeat;
  let heartbeatPct = 15;
  let downloaded = 0;
  let estimated = 0;
  let lastReported = 0;

  const reportPct = (pct) => {
    if (typeof onProgress !== "function") return;
    const next = Math.min(95, Math.max(lastReported, Math.round(pct)));
    if (next > lastReported) {
      lastReported = next;
      onProgress(lastReported);
    }
  };

  const bumpWaitProgress = () => {
    if (downloaded > 0) return;
    if (heartbeatPct < 88) {
      heartbeatPct += 2;
      reportPct(heartbeatPct);
    }
  };

  heartbeat = setInterval(bumpWaitProgress, 2000);
  bumpWaitProgress();

  try {
    const res = await axios.get(mediaUrl, {
      responseType: "stream",
      timeout: cobaltMediaTimeoutMs(),
      headers: {
        Accept: "*/*",
        "User-Agent": "Connect-Server/1.0",
      },
      maxRedirects: 5,
      validateStatus: () => true,
    });

    if (res.status >= 400) {
      const chunks = [];
      for await (const chunk of res.data) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString("utf8").slice(0, 300);
      throw new Error(`Cobalt media download HTTP ${res.status}: ${body}`);
    }

    const contentType = String(res.headers["content-type"] || "");
    if (contentType.includes("application/json")) {
      const chunks = [];
      for await (const chunk of res.data) chunks.push(chunk);
      throw new Error(
        `Cobalt returned JSON instead of video: ${Buffer.concat(chunks).toString("utf8").slice(0, 300)}`,
      );
    }

    const total = Number(
      res.headers["content-length"] ||
        res.headers["estimated-content-length"] ||
        0,
    );
    estimated = Number(res.headers["estimated-content-length"] || 0);
    if (total === 0 && String(res.headers["content-length"]) === "0") {
      res.data.destroy?.();
      throw new Error(
        "Cobalt download too small (0 bytes). Refresh home Cobalt cookies or set YOUTUBE_PO_TOKEN + YOUTUBE_VISITOR_DATA in live.env.",
      );
    }

    res.data.on("data", (chunk) => {
      downloaded += chunk.length;
      if (total > 0) {
        reportPct(15 + (downloaded / total) * 80);
      } else {
        reportPct(15 + downloaded / (512 * 1024));
      }
    });

    await pipeline(res.data, fs.createWriteStream(destPath));

    const fileSize = fs.existsSync(destPath)
      ? fs.statSync(destPath).size
      : downloaded;

    if (fileSize < 1000) {
      throw new Error(`Cobalt download too small (${fileSize} bytes)`);
    }

    if (estimated > 0 && fileSize < estimated * 0.5) {
      throw new Error(
        `Cobalt download looks truncated (${fileSize} of ~${estimated} bytes). Try again or use yt-dlp fallback.`,
      );
    }
  } finally {
    clearInterval(heartbeat);
  }
};

/** Quality attempts — HQ merged video+audio first, then step down. */
const buildAttemptExtras = (height) => {
  const requested = heightToQuality(height);
  const requestedNum = Number(requested);
  const ordered = [];
  const seen = new Set();

  const add = (videoQuality, extra = {}) => {
    const key = `${videoQuality}:${extra.youtubeHLS ? "hls" : ""}`;
    if (seen.has(key)) return;
    seen.add(key);
    ordered.push({
      videoQuality: String(videoQuality),
      youtubeBetterAudio: true,
      ...extra,
    });
  };

  if (!height || requestedNum >= 1080) {
    add("max");
  }
  add(requested);
  for (const q of ["2160", "1440", "1080", "720", "480", "360"]) {
    if (q !== String(requested)) add(q);
  }
  add("max", { youtubeHLS: true });

  return ordered;
};

const isRetryableCobaltError = (message) => {
  const lower = String(message || "").toLowerCase();
  return (
    lower.includes("video.unavailable") ||
    lower.includes("no_matching_format") ||
    lower.includes("fetch.fail") ||
    lower.includes("login") ||
    lower.includes("format")
  );
};

/** Audio-only attempt(s) — Cobalt extracts and transcodes to the requested format. */
const buildAudioAttemptExtras = () => [
  { downloadMode: "audio", audioFormat: "mp3" },
  { downloadMode: "audio", audioFormat: "best" },
];

const downloadViaCobalt = async ({
  url,
  height,
  audioOnly,
  outputDir,
  outputPrefix,
  onProgress,
}) => {
  const instances = getCobaltInstances();
  if (!instances.length) {
    throw new Error("No Cobalt API URL configured. Set COBALT_API_URL.");
  }

  fs.mkdirSync(outputDir, { recursive: true });
  let lastError = null;
  const attempts = audioOnly
    ? buildAudioAttemptExtras()
    : buildAttemptExtras(height);
  const destExt = audioOnly ? "mp3" : "mp4";

  for (const base of instances) {
    for (const extras of attempts) {
      const destPath = path.join(outputDir, `${outputPrefix}.${destExt}`);
      try {
        console.log(
          audioOnly
            ? `[yt-download] Cobalt via ${base} downloadMode=audio format=${extras.audioFormat}`
            : `[yt-download] Cobalt via ${base} quality=${extras.videoQuality}${extras.youtubeHLS ? " hls" : ""}`,
        );
        if (typeof onProgress === "function") onProgress(8);

        const { mediaUrl, title } = await requestCobalt(
          base,
          url,
          height,
          extras,
        );
        if (typeof onProgress === "function") onProgress(15);

        await downloadFileFromUrl(mediaUrl, destPath, onProgress);

        if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
          throw new Error("Cobalt download produced an empty file");
        }

        return {
          filePath: destPath,
          title: title || (audioOnly ? "audio" : "video"),
          source: "cobalt",
        };
      } catch (err) {
        lastError = err;
        console.warn(
          `[yt-download] Cobalt ${base} failed:`,
          err.message?.slice(0, 220),
        );
        if (fs.existsSync(destPath)) {
          try {
            fs.unlinkSync(destPath);
          } catch (_) {}
        }
        if (!isRetryableCobaltError(err.message)) {
          break;
        }
      }
    }
  }

  throw lastError || new Error("All Cobalt instances failed");
};

module.exports = {
  downloadViaCobalt,
};
