const {
  startDownloadJob,
  getProgress,
} = require("../services/ytDownloadService");

const getPublicBaseUrl = (req) => {
  const fromEnv =
    process.env.PUBLIC_SERVER_URL || process.env.RENDER_EXTERNAL_URL;
  let base = fromEnv ? String(fromEnv).replace(/\/+$/, "") : "";

  if (!base) {
    const proto = String(
      req.get("x-forwarded-proto") || req.protocol || "https",
    )
      .split(",")[0]
      .trim();
    const host = String(req.get("x-forwarded-host") || req.get("host") || "")
      .split(",")[0]
      .trim();
    base = `${proto}://${host}`;
  }

  if (process.env.RENDER === "true" || /\.onrender\.com$/i.test(base)) {
    base = base.replace(/^http:\/\//i, "https://");
  }

  return base;
};

exports.startDownload = async (req, res) => {
  try {
    const url = req.query.url;
    const height = req.query.height ? parseInt(req.query.height, 10) : null;
    const asyncJob = req.query.async_job !== "false";
    const audioOnly = req.query.audio_only === "true";
    // Post to Watch after download when requested (requires auth); audio-only downloads never post to Watch
    const postAsWatch = req.query.post_as_watch !== "false" && !audioOnly;

    if (!url) {
      return res.status(400).json({ error: "url query parameter is required" });
    }

    const baseUrl = getPublicBaseUrl(req);
    const profileId = req.profile?._id;

    if (!profileId) {
      return res.status(401).json({
        error: "Authentication required",
        message: "Please log in to download videos",
      });
    }

    if (!asyncJob) {
      return res.status(400).json({
        error: "Synchronous downloads are not supported. Use async_job=true",
      });
    }

    const progressId = startDownloadJob({
      baseUrl,
      url,
      height: Number.isFinite(height) ? height : null,
      postAsWatch,
      profileId,
      audioOnly,
    });

    return res.status(202).json({
      status: "accepted",
      progress_id: progressId,
      progress_url: `${baseUrl}/progress/${progressId}`,
      note: "Job started. Poll progress_url until status=completed to get file_url.",
    });
  } catch (error) {
    console.error("startDownload error:", error);
    return res
      .status(500)
      .json({ error: error.message || "Failed to start download" });
  }
};

exports.getProgress = async (req, res) => {
  res.set({
    "Cache-Control": "no-store, no-cache, must-revalidate, proxy-revalidate",
    Pragma: "no-cache",
    Expires: "0",
  });

  const data = await getProgress(req.params.progressId);
  if (!data) {
    return res.status(404).json({ error: "Progress id not found" });
  }
  return res.json(data);
};
