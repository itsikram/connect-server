const normalizeCobaltUrl = (raw) => {
  if (raw === undefined || raw === null) return "";
  const value = String(raw).trim();
  if (!value) return "";
  const withoutTrailingSlash = value.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(withoutTrailingSlash)) {
    return `https://${withoutTrailingSlash}`;
  }
  return withoutTrailingSlash;
};

const state = {
  url: normalizeCobaltUrl(process.env.COBALT_API_URL || ""),
  source: process.env.COBALT_API_URL ? "env" : "unset",
  updatedAt: process.env.COBALT_API_URL ? new Date().toISOString() : null,
};

const getCobaltUrl = () => {
  const current = normalizeCobaltUrl(process.env.COBALT_API_URL || state.url || "");
  if (current && !state.url) {
    state.url = current;
    state.source = "env";
    state.updatedAt = new Date().toISOString();
  }
  if (current && state.url !== current) {
    state.url = current;
    state.source = "env";
    state.updatedAt = new Date().toISOString();
  }
  return current;
};

const applyCobaltUrl = (rawUrl, source = "remote") => {
  const nextUrl = normalizeCobaltUrl(rawUrl || "");
  if (!nextUrl) {
    return {
      ok: false,
      error: "Missing cobalt URL",
      url: "",
      changed: false,
      source,
    };
  }

  const changed = state.url !== nextUrl || process.env.COBALT_API_URL !== nextUrl;
  state.url = nextUrl;
  state.source = source;
  state.updatedAt = new Date().toISOString();
  process.env.COBALT_API_URL = nextUrl;

  if (changed && global.io) {
    global.io.emit("youtube-cobalt-url", {
      url: nextUrl,
      source,
      updatedAt: state.updatedAt,
    });
  }

  return {
    ok: true,
    url: nextUrl,
    changed,
    source,
    updatedAt: state.updatedAt,
  };
};

const getCobaltConfig = () => ({
  url: getCobaltUrl(),
  source: state.source,
  updatedAt: state.updatedAt,
});

module.exports = {
  normalizeCobaltUrl,
  getCobaltUrl,
  applyCobaltUrl,
  getCobaltConfig,
};
