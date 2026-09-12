const axios = require("axios");
const { v2: cloudinary } = require("cloudinary");

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME || "",
  api_key: process.env.CLOUDINARY_API_KEY || "",
  api_secret: process.env.CLOUDINARY_API_SECRET || "",
});

/**
 * Provider-neutral image generation boundary. A provider can be configured
 * with AI_IMAGE_GENERATION_URL without coupling auto-posts to its API shape.
 */
const generateImage = async ({ prompt, provider = "configured" }) => {
  if (!prompt) return { imageUrl: "", provider: "none" };

  const endpoint = String(process.env.AI_IMAGE_GENERATION_URL || "").trim();
  let sourceUrl = "";
  let resolvedProvider = provider;

  if (endpoint) {
    const response = await axios.post(endpoint, { prompt }, {
      timeout: 30000,
      validateStatus: () => true,
    });
    sourceUrl = response.data?.url || response.data?.imageUrl || response.data?.data?.url || "";
    if (response.status >= 400 || !sourceUrl) {
      throw new Error("Configured image provider did not return a usable image URL");
    }
  } else {
    // Gemini creates the concept prompt, not pixels. Pollinations is the
    // dependency-free default provider; deployments can replace it with the
    // configured endpoint above without changing auto-post code.
    resolvedProvider = "pollinations";
    sourceUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt.slice(0, 700))}?width=1024&height=1024&nologo=true`;
  }

  const hasCloudinary = process.env.CLOUDINARY_CLOUD_NAME &&
    process.env.CLOUDINARY_API_KEY &&
    process.env.CLOUDINARY_API_SECRET;
  if (!hasCloudinary) return { imageUrl: String(sourceUrl).slice(0, 1000), provider: resolvedProvider };

  const uploaded = await cloudinary.uploader.upload(sourceUrl, {
    folder: "ai-auto-posts",
    resource_type: "image",
  });
  if (!uploaded?.secure_url) throw new Error("Generated image could not be stored in Cloudinary");
  return { imageUrl: uploaded.secure_url, provider: resolvedProvider };
};

module.exports = { generateImage };
