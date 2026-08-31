const fs = require("fs");
const path = require("path");
const axios = require("axios");
const mongoose = require("mongoose");
const { v4: uuidv4 } = require("uuid");
const ytdl = require("@distube/ytdl-core");
const { v2: cloudinary } = require("cloudinary");
const Watch = require("../models/Watch");
const YtDownloadProgress = require("../models/YtDownloadProgress");
const generateAndUploadThumbnail = require("../utils/generateThumbnail");
const {
  isYtDlpAvailable,
  downloadWithYtDlp,
  getBundledYtDlpPath,
  isBotBlockError,
  formatBotBlockError,
  normalizeYouTubeUrl,
  isFormatUnavailableError,
} = require("./ytDlpRunner");
const { downloadViaCobalt } = require("./ytCobaltFallback");

const DOWNLOAD_DIR = path.join(require("os").tmpdir(), "connect-yt-downloads");
const JOB_PROGRESS = new Map();

/** Limit parallel YouTube jobs so home Cobalt / PC stays responsive. */
const YT_DL_MAX_CONCURRENT = Math.max(
  1,
  parseInt(process.env.YT_DL_MAX_CONCURRENT || "2", 10) || 2,
);
let ytDownloadActive = 0;
const ytDownloadWaiters = [];

const acquireDownloadSlot = () =>
  new Promise((resolve) => {
    if (ytDownloadActive < YT_DL_MAX_CONCURRENT) {
      ytDownloadActive += 1;
      resolve();
      return;
    }
    ytDownloadWaiters.push(resolve);
  });

const releaseDownloadSlot = () => {
  ytDownloadActive = Math.max(0, ytDownloadActive - 1);
  const next = ytDownloadWaiters.shift();
  if (next) {
    ytDownloadActive += 1;
    next();
  }
};

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

if (!fs.existsSync(DOWNLOAD_DIR)) {
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
}

const isRenderHost = () =>
  process.env.RENDER === "true" || process.env.YT_DL_RENDER_MODE === "true";

let cachedAgent = null;

const getYtdlAgent = () => {
  if (cachedAgent) return cachedAgent;

  const cookiesJson = process.env.YOUTUBE_COOKIES_JSON;
  const cookiesFile = process.env.YOUTUBE_COOKIES_FILE;

  try {
    if (cookiesJson) {
      const cookies = JSON.parse(cookiesJson);
      if (Array.isArray(cookies) && cookies.length) {
        cachedAgent = ytdl.createAgent(cookies);
        return cachedAgent;
      }
    }
    if (cookiesFile && fs.existsSync(cookiesFile)) {
      const cookies = JSON.parse(fs.readFileSync(cookiesFile, "utf8"));
      if (Array.isArray(cookies) && cookies.length) {
        cachedAgent = ytdl.createAgent(cookies);
        return cachedAgent;
      }
    }
  } catch (err) {
    console.warn("Failed to load YouTube cookies for ytdl-core:", err.message);
  }

  return null;
};

const sanitizeFileName = (name) => {
  if (!name) return "video";
  return (
    String(name)
      .replace(/\.[^/.]+$/, "")
      .replace(/[^a-zA-Z0-9. -]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .substring(0, 100) || "video"
  );
};

const pickFormat = (formats, targetHeight) => {
  const withAv = formats.filter((f) => f.hasVideo && f.hasAudio);
  if (!withAv.length) {
    return ytdl.chooseFormat(formats, {
      quality: "highest",
      filter: "videoandaudio",
    });
  }
  if (!targetHeight) {
    return withAv.sort((a, b) => (b.height || 0) - (a.height || 0))[0];
  }
  const matching = withAv
    .filter((f) => f.height && f.height <= targetHeight)
    .sort((a, b) => (b.height || 0) - (a.height || 0));
  return (
    matching[0] || withAv.sort((a, b) => (b.height || 0) - (a.height || 0))[0]
  );
};

const persistProgressToDb = (progressId, data) => {
  if (!isRenderHost() || mongoose.connection.readyState !== 1) return;

  YtDownloadProgress.findByIdAndUpdate(
    progressId,
    { $set: { ...data, _id: progressId } },
    { upsert: true },
  ).catch((err) => {
    console.warn("[yt-download] progress persist failed:", err.message);
  });
};

const updateProgress = (progressId, patch) => {
  const prev = JOB_PROGRESS.get(progressId) || {};
  const next = { ...prev, ...patch };
  JOB_PROGRESS.set(progressId, next);
  persistProgressToDb(progressId, next);
};

const getProgress = async (progressId) => {
  const cached = JOB_PROGRESS.get(progressId);
  if (cached) return cached;

  if (!isRenderHost() || mongoose.connection.readyState !== 1) {
    return null;
  }

  try {
    const doc = await YtDownloadProgress.findById(progressId).lean();
    if (!doc) return null;

    const { _id, __v, createdAt, updatedAt, ...data } = doc;
    JOB_PROGRESS.set(progressId, data);
    return data;
  } catch (err) {
    console.warn("[yt-download] progress load failed:", err.message);
    return null;
  }
};

const shouldUseYtdlCore = () => {
  if (isRenderHost()) return false;
  if (process.env.YT_DL_USE_YTDL_CORE === "true") return true;
  if (process.env.YT_DL_USE_YTDL_CORE === "false") return false;
  if (process.env.NODE_ENV === "production") return false;
  return true;
};

const isValidYouTubeUrl = (url) =>
  ytdl.validateURL(url) ||
  url.includes("youtube.com") ||
  url.includes("youtu.be");

const downloadToFileYtdlCore = (info, format, filePath, agent, onProgress) =>
  new Promise((resolve, reject) => {
    const stream = ytdl.downloadFromInfo(info, {
      format,
      agent: agent || undefined,
    });
    const writeStream = fs.createWriteStream(filePath);
    let downloaded = 0;

    stream.on("data", (chunk) => {
      downloaded += chunk.length;
      if (typeof onProgress === "function") {
        onProgress(downloaded);
      }
    });

    stream.on("error", reject);
    writeStream.on("error", reject);
    writeStream.on("finish", resolve);
    stream.pipe(writeStream);
  });

const uploadVideoToCloudinary = (filePath, folder = "yt-downloads") =>
  new Promise((resolve, reject) => {
    cloudinary.uploader.upload(
      filePath,
      { resource_type: "video", folder },
      (error, result) => {
        if (error) return reject(error);
        resolve(result);
      },
    );
  });

const createWatchFromVideo = async (videoUrl, caption, profileId) => {
  const watchCaption =
    String(caption || "YouTube Video")
      .trim()
      .slice(0, 500) || "YouTube Video";
  let thumbnail = "";
  try {
    const result = await generateAndUploadThumbnail(videoUrl);
    thumbnail = result?.secure_url || "";
  } catch (err) {
    console.warn("Watch thumbnail generation failed:", err.message);
    if (videoUrl && videoUrl.includes("/upload/")) {
      thumbnail = videoUrl
        .replace("/video/upload/", "/video/upload/so_1,w_720,h_405,c_fill/")
        .replace(/\.(mp4|mov|webm|mkv|avi)(\?.*)?$/i, ".jpg$2");
    }
  }

  const watch = new Watch({
    caption: watchCaption,
    videoUrl,
    author: profileId,
    thumbnail,
    feeling: "",
    audience: 3,
  });

  return watch.save();
};

/** Reliable YouTube title for Watch caption (works even when yt-dlp filename is a UUID). */
const fetchYouTubeTitle = async (url) => {
  try {
    const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
    const res = await axios.get(oembedUrl, {
      timeout: 15000,
      headers: { "User-Agent": "Connect-Server/1.0" },
    });
    const title = res.data?.title;
    if (title && String(title).trim()) return String(title).trim();
  } catch (err) {
    console.warn("[yt-download] oEmbed title failed:", err.message);
  }
  return null;
};

const downloadWithYtDlpBackend = async ({
  progressId,
  url,
  height,
  audioOnly,
}) => {
  let lastPct = 5;
  const report = (patch) => {
    if (patch.pct !== undefined && patch.pct >= lastPct) {
      lastPct = patch.pct;
    }
    updateProgress(progressId, {
      status: "running",
      ...patch,
      pct: patch.pct !== undefined ? patch.pct : lastPct,
    });
  };

  if (!(await isYtDlpAvailable())) {
    const bundled = getBundledYtDlpPath();
    throw new Error(
      bundled
        ? "yt-dlp binary missing or not executable on this server"
        : "yt-dlp is not installed. Add youtube-dl-exec to package.json and redeploy.",
    );
  }

  console.log("[yt-download] Downloading with yt-dlp on Node.js server");
  report({ stage: "downloading", pct: 5, source: "yt-dlp" });

  const { filePath, title } = await downloadWithYtDlp({
    url,
    outputDir: DOWNLOAD_DIR,
    outputPrefix: progressId,
    height,
    audioOnly,
    onProgress: (pct) =>
      report({
        stage: "downloading",
        pct,
        title: audioOnly ? "audio" : "video",
        download_title: audioOnly ? "audio" : "video",
      }),
  });

  return {
    title: title || (audioOnly ? "audio" : "video"),
    source: "yt-dlp",
    filePath,
  };
};

const downloadViaCobaltBackend = async ({
  progressId,
  url,
  height,
  audioOnly,
}) => {
  let lastPct = 5;
  const report = (pct, stage = "downloading") => {
    if (pct >= lastPct) lastPct = pct;
    updateProgress(progressId, {
      status: "running",
      stage,
      pct: lastPct,
      source: "cobalt",
      title: "video",
      download_title: "video",
    });
  };

  console.log("[yt-download] Downloading via Cobalt API");
  report(5, "starting");

  let heartbeat = setInterval(() => {
    if (lastPct < 14) report(lastPct + 1, "preparing");
  }, 1500);

  try {
    return await downloadViaCobalt({
      url,
      height,
      audioOnly,
      outputDir: DOWNLOAD_DIR,
      outputPrefix: progressId,
      onProgress: (pct) => report(pct, pct < 20 ? "preparing" : "downloading"),
    });
  } finally {
    clearInterval(heartbeat);
  }
};

const downloadVideo = async ({ progressId, url, height, audioOnly }) => {
  let lastError = null;
  const cobaltEnabled = process.env.YT_DL_DISABLE_COBALT !== "true";
  const hasCobaltUrl = Boolean(process.env.COBALT_API_URL);
  const onRender = isRenderHost();
  const cobaltOnly = process.env.YT_DL_COBALT_ONLY === "true" || onRender;

  if (onRender && !hasCobaltUrl) {
    throw new Error(
      "COBALT_API_URL is not set on Render. YouTube blocks Render IPs — " +
        "set COBALT_API_URL to your home Cobalt tunnel URL and redeploy.",
    );
  }

  // Prefer Cobalt on Render, or when YT_DL_PREFER_COBALT / YT_DL_COBALT_ONLY (local test)
  const preferCobalt =
    cobaltEnabled &&
    hasCobaltUrl &&
    (onRender || process.env.YT_DL_PREFER_COBALT === "true" || cobaltOnly);

  const tryYtDlp = async () => {
    if (cobaltOnly) {
      console.log("[yt-download] Skipping yt-dlp (Cobalt-only mode on Render)");
      return null;
    }
    try {
      return await downloadWithYtDlpBackend({
        progressId,
        url,
        height,
        audioOnly,
      });
    } catch (err) {
      lastError = err;
      console.warn("[yt-download] yt-dlp failed:", err.message);
      return null;
    }
  };

  const tryCobalt = async () => {
    if (!cobaltEnabled) return null;
    try {
      return await downloadViaCobaltBackend({
        progressId,
        url,
        height,
        audioOnly,
      });
    } catch (cobaltErr) {
      console.warn("[yt-download] Cobalt failed:", cobaltErr.message);
      lastError = cobaltErr;
      return null;
    }
  };

  if (preferCobalt) {
    console.log(
      cobaltOnly
        ? "[yt-download] Cobalt-only mode (Render / YT_DL_COBALT_ONLY)"
        : "[yt-download] Prefer Cobalt first",
    );
    console.log(`[yt-download] Cobalt URL: ${process.env.COBALT_API_URL}`);
    const cobaltResult = await tryCobalt();
    if (cobaltResult) return cobaltResult;

    if (onRender) {
      const detail = lastError?.message || "Unknown Cobalt error";
      throw new Error(
        `Home Cobalt download failed: ${detail}. ` +
          "YouTube blocks Render directly — keep home Cobalt running and refresh the tunnel URL.",
      );
    }

    console.warn("[yt-download] Cobalt unavailable — falling back to yt-dlp");
    const ytResult = await tryYtDlp();
    if (ytResult) return ytResult;
  } else {
    const ytResult = await tryYtDlp();
    if (ytResult) return ytResult;
    const cobaltResult = await tryCobalt();
    if (cobaltResult) return cobaltResult;
  }

  // Local-dev-only: ytdl-core
  if (shouldUseYtdlCore() && ytdl.validateURL(url)) {
    const agent = getYtdlAgent();
    const filePath = path.join(
      DOWNLOAD_DIR,
      audioOnly ? `${progressId}_audio.m4a` : `${progressId}_video.mp4`,
    );
    let lastPct = 5;
    const report = (patch) => {
      if (patch.pct !== undefined && patch.pct >= lastPct) {
        lastPct = patch.pct;
      }
      updateProgress(progressId, {
        status: "running",
        ...patch,
        pct: patch.pct !== undefined ? patch.pct : lastPct,
      });
    };

    try {
      report({ stage: "downloading", pct: 5, source: "ytdl-core" });
      const info = await ytdl.getInfo(url, agent ? { agent } : undefined);
      const title = info.videoDetails?.title || (audioOnly ? "audio" : "video");
      const format = audioOnly
        ? ytdl.chooseFormat(info.formats, {
            quality: "highestaudio",
            filter: "audioonly",
          })
        : pickFormat(info.formats, height);

      if (!format) {
        throw new Error(
          audioOnly
            ? "No suitable audio format found"
            : "No suitable video format found",
        );
      }

      await downloadToFileYtdlCore(
        info,
        format,
        filePath,
        agent,
        (downloaded) => {
          const contentLength = format.contentLength
            ? Number(format.contentLength)
            : 0;
          let pct = lastPct;
          if (contentLength > 0) {
            pct = Math.min(95, Math.round((downloaded / contentLength) * 100));
          } else {
            pct = Math.min(95, lastPct + 1);
          }
          report({ stage: "downloading", pct, title, download_title: title });
        },
      );

      return { title, source: "ytdl-core", filePath };
    } catch (ytdlErr) {
      console.warn("[yt-download] ytdl-core failed:", ytdlErr.message);
      if (filePath && fs.existsSync(filePath)) {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {}
      }
      lastError = ytdlErr;
    }
  }

  if (onRender && !hasCobaltUrl) {
    throw new Error(
      "YouTube blocks Render IPs. Set COBALT_API_URL to your home Cobalt tunnel and redeploy.",
    );
  }

  const msg = lastError?.message || "YouTube download failed.";
  throw new Error(
    isBotBlockError(msg) || isFormatUnavailableError(msg)
      ? formatBotBlockError()
      : msg,
  );
};

const runDownloadJob = async ({
  progressId,
  baseUrl,
  url,
  height,
  postAsWatch,
  profileId,
  audioOnly,
}) => {
  let filePath = null;
  await acquireDownloadSlot();

  try {
    updateProgress(progressId, {
      stage: "starting",
      status: "running",
      pct: 0,
    });

    const normalizedUrl = normalizeYouTubeUrl(url);
    if (!isValidYouTubeUrl(normalizedUrl)) {
      throw new Error("Invalid YouTube URL");
    }

    // Always post to Watch when the user is authenticated (audio-only downloads never post to Watch)
    const shouldPostWatch =
      Boolean(profileId) && postAsWatch !== false && !audioOnly;

    // Fetch real YouTube title early for Watch caption + UI
    const oembedTitle = await fetchYouTubeTitle(normalizedUrl);
    if (oembedTitle) {
      updateProgress(progressId, {
        title: oembedTitle,
        download_title: oembedTitle,
      });
    }

    const result = await downloadVideo({
      progressId,
      url: normalizedUrl,
      height,
      audioOnly,
    });

    const looksLikeUuid = (t) =>
      /^[a-f0-9-]{16,}$/i.test(String(t || "").replace(/\s/g, ""));
    const downloadedTitle =
      result.title && !looksLikeUuid(result.title) ? result.title : null;
    const finalTitle =
      oembedTitle ||
      downloadedTitle ||
      (audioOnly ? "YouTube Audio" : "YouTube Video");
    filePath = result.filePath;

    if (!filePath || !fs.existsSync(filePath)) {
      throw new Error("Download completed but file was not found on server");
    }

    updateProgress(progressId, {
      stage: "uploading",
      status: "running",
      pct: 96,
      title: finalTitle,
      download_title: finalTitle,
    });

    // Always upload to Cloudinary — do not serve from local/public disk
    const uploadFolder = shouldPostWatch
      ? "watch-videos"
      : audioOnly
        ? "yt-downloads-audio"
        : "yt-downloads";
    const uploadResult = await uploadVideoToCloudinary(filePath, uploadFolder);
    if (!uploadResult?.secure_url) {
      throw new Error("Failed to upload video to Cloudinary");
    }

    const fileUrl = uploadResult.secure_url;
    let watchPosted = false;
    let watchId = null;

    if (shouldPostWatch) {
      updateProgress(progressId, {
        stage: "uploading_watch",
        status: "running",
        pct: 98,
        title: finalTitle,
        download_title: finalTitle,
      });
      // Caption = YouTube video title
      const watch = await createWatchFromVideo(fileUrl, finalTitle, profileId);
      watchPosted = true;
      watchId = String(watch._id);
      console.log(
        `[yt-download] Posted Watch with caption: ${finalTitle.slice(0, 80)}`,
      );
    }

    // Remove temp file after Cloudinary upload
    try {
      fs.unlinkSync(filePath);
    } catch (_) {}
    filePath = null;

    updateProgress(progressId, {
      stage: "completed",
      status: "completed",
      pct: 100,
      file_url: fileUrl,
      title: finalTitle,
      download_title: finalTitle,
      watch_posted: watchPosted,
      watch_id: watchId,
      watch_caption: watchPosted ? finalTitle : undefined,
      source: result.source,
      storage: "cloudinary",
      download_type: audioOnly ? "audio" : "video",
    });
  } catch (error) {
    console.error("YouTube download job failed:", error);
    if (filePath && fs.existsSync(filePath)) {
      try {
        fs.unlinkSync(filePath);
      } catch (_) {}
    }

    updateProgress(progressId, {
      stage: "failed",
      status: "failed",
      error: error.message || "Download failed",
    });
  } finally {
    releaseDownloadSlot();
  }
};

const startDownloadJob = ({
  baseUrl,
  url,
  height,
  postAsWatch,
  profileId,
  audioOnly,
}) => {
  const progressId = uuidv4().replace(/-/g, "");

  JOB_PROGRESS.set(progressId, {
    stage: "starting",
    status: "running",
    pct: 0,
  });

  if (isRenderHost()) {
    const bundled = getBundledYtDlpPath();
    console.log(
      "[yt-download] Node.js-only mode on Render. yt-dlp binary:",
      bundled || "checking on first download...",
    );
  }

  setImmediate(() => {
    runDownloadJob({
      progressId,
      baseUrl,
      url,
      height,
      postAsWatch,
      profileId,
      audioOnly,
    });
  });

  return progressId;
};

const decodeYoutubeHtml = (value) =>
  String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();

const searchYouTubeVideos = async (query, maxResults = 12) => {
  const apiKey = String(process.env.YOUTUBE_API_KEY || "").trim();
  if (!apiKey) {
    const err = new Error("YouTube search is not configured");
    err.code = "YOUTUBE_API_KEY_MISSING";
    err.status = 503;
    throw err;
  }

  const q = String(query || "").trim();
  if (!q) {
    const err = new Error("Search query is required");
    err.status = 400;
    throw err;
  }

  const limit = Math.min(Math.max(Number(maxResults) || 12, 1), 25);

  try {
    const { data } = await axios.get(
      "https://www.googleapis.com/youtube/v3/search",
      {
        params: {
          part: "snippet",
          type: "video",
          maxResults: limit,
          q,
          key: apiKey,
        },
        timeout: 15000,
        headers: { "User-Agent": "Connect-Server/1.0" },
      },
    );

    const items = (data?.items || [])
      .filter((item) => item?.id?.videoId)
      .map((item) => {
        const videoId = item.id.videoId;
        const snippet = item.snippet || {};
        const thumbs = snippet.thumbnails || {};
        return {
          videoId,
          title: decodeYoutubeHtml(snippet.title) || "Untitled",
          channelTitle: decodeYoutubeHtml(snippet.channelTitle),
          thumbnail:
            thumbs.medium?.url ||
            thumbs.high?.url ||
            thumbs.default?.url ||
            `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        };
      });

    return { items };
  } catch (err) {
    if (err.code === "YOUTUBE_API_KEY_MISSING" || err.status === 400) {
      throw err;
    }
    const ytMessage =
      err.response?.data?.error?.message ||
      err.message ||
      "YouTube search failed";
    const wrapped = new Error(ytMessage);
    wrapped.status = err.response?.status || 500;
    throw wrapped;
  }
};

module.exports = {
  DOWNLOAD_DIR,
  startDownloadJob,
  getProgress,
  isRenderHost,
  searchYouTubeVideos,
};
