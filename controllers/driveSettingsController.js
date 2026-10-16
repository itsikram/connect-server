const jwt = require("jsonwebtoken");
const {
  ACCOUNT_NAME_PATTERN,
  loadDriveSettings,
  getEffectiveDriveConfig,
  updateDriveSettings,
  saveAccount,
  setAccountEnabled,
  removeAccount,
} = require("../utils/driveSettingsStore");
const {
  createOAuthClient,
  createDrive,
  getGoogleErrorReason,
  getDriveStorageStatus,
  isDriveStorageEnabled,
} = require("../utils/googleDrive");

const SECRET_KEY = process.env.JWT_SECRET_KEY;
const STATE_PURPOSE = "gdrive-connect";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"];

// Google sends the admin back here; it must be listed as an authorized
// redirect URI on the OAuth client (type "Web application").
const getRedirectUri = (req) => `${req.protocol}://${req.get("host")}/api/admin/gdrive/callback`;

const maskClientId = (value) => (value ? `${value.slice(0, 12)}…${value.slice(-27)}` : "");

const sendError = (res, error, fallback) =>
  res.status(error.status || 500).json({ message: error.message || fallback });

/** Settings for the admin page. Secrets and tokens are never sent back. */
exports.getDriveSettings = async (req, res) => {
  try {
    const [doc, effective, status] = await Promise.all([
      loadDriveSettings({ fresh: true }),
      getEffectiveDriveConfig(),
      getDriveStorageStatus(),
    ]);
    return res.status(200).json({
      uploadsEnabled: doc.uploadsEnabled,
      envMediaStorage: process.env.MEDIA_STORAGE || "",
      active: await isDriveStorageEnabled(),
      clientId: doc.clientId,
      hasClientSecret: Boolean(doc.clientSecret),
      // Where the OAuth client in use comes from when not saved here
      envClient: !doc.clientId && process.env.GDRIVE_CLIENT_ID ? maskClientId(process.env.GDRIVE_CLIENT_ID) : "",
      clientConfigured: Boolean(effective.clientId && effective.clientSecret),
      publicBaseUrl: doc.publicBaseUrl,
      envPublicBaseUrl: process.env.MEDIA_PUBLIC_BASE_URL || "",
      redirectUri: getRedirectUri(req),
      accounts: status.map(({ name, email, enabled, source, limit, usage, free, error }) => ({
        name,
        email,
        enabled,
        source,
        ...(error ? { error } : { limit, usage, free: free === Number.MAX_SAFE_INTEGER ? null : free }),
      })),
      updatedAt: doc.updatedAt,
    });
  } catch (error) {
    return sendError(res, error, "Failed to load Google Drive settings");
  }
};

exports.updateDriveSettings = async (req, res) => {
  try {
    await updateDriveSettings(req.body || {});
    return exports.getDriveSettings(req, res);
  } catch (error) {
    return sendError(res, error, "Failed to save Google Drive settings");
  }
};

/** Starts connecting a Google account: returns the Google sign-in URL. */
exports.startConnect = async (req, res) => {
  try {
    const name = String(req.body?.name || "").trim();
    if (!ACCOUNT_NAME_PATTERN.test(name)) {
      return res.status(400).json({ message: "Name must be 1-32 letters, numbers, - or _" });
    }
    const config = await getEffectiveDriveConfig();
    if (!config.clientId || !config.clientSecret) {
      return res.status(400).json({ message: "Save the Google OAuth client ID and secret first" });
    }
    const existing = config.accounts.find((a) => a.name === name);
    if (existing?.source === "env") {
      return res.status(400).json({ message: `"${name}" is set in the server .env; pick another name` });
    }

    const redirectUri = getRedirectUri(req);
    const state = jwt.sign(
      {
        purpose: STATE_PURPOSE,
        name,
        admin_id: req.admin?.id,
        returnTo: String(req.body?.returnTo || ""),
        redirectUri,
      },
      SECRET_KEY,
      { expiresIn: "15m" },
    );
    const url = createOAuthClient(config.clientId, config.clientSecret, redirectUri).generateAuthUrl({
      access_type: "offline",
      prompt: "consent select_account",
      scope: SCOPES,
      state,
    });
    return res.status(200).json({ url, redirectUri });
  } catch (error) {
    return sendError(res, error, "Failed to start Google sign-in");
  }
};

// Only send the admin back to an http(s) page; anything else gets a plain message
const buildReturnUrl = (returnTo, params) => {
  try {
    const url = new URL(returnTo);
    if (!["http:", "https:"].includes(url.protocol)) return null;
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  } catch {
    return null;
  }
};

const finish = (res, returnTo, params) => {
  const target = returnTo && buildReturnUrl(returnTo, params);
  if (target) return res.redirect(302, target);
  res.status(params.gdrive === "connected" ? 200 : 400).type("text/plain");
  return res.send(
    params.gdrive === "connected"
      ? `Connected ${params.email || "account"}. You can close this tab.`
      : `Google Drive connection failed: ${params.message}`,
  );
};

/** Google redirects here after sign-in. Authenticated by the signed state. */
exports.connectCallback = async (req, res) => {
  let state;
  try {
    state = jwt.verify(String(req.query.state || ""), SECRET_KEY);
    if (state?.purpose !== STATE_PURPOSE) throw new Error("bad state");
  } catch {
    return finish(res, null, { gdrive: "error", message: "Sign-in link expired. Start again from the admin panel." });
  }

  const returnTo = state.returnTo;
  try {
    if (req.query.error) {
      throw new Error(req.query.error === "access_denied" ? "Access was denied on the Google screen" : String(req.query.error));
    }
    const config = await getEffectiveDriveConfig();
    const client = createOAuthClient(config.clientId, config.clientSecret, state.redirectUri);
    const { tokens } = await client.getToken(String(req.query.code || ""));
    if (!tokens.refresh_token) {
      throw new Error("Google did not return a refresh token. Remove the app at myaccount.google.com/permissions and try again.");
    }
    client.setCredentials(tokens);
    const { data } = await createDrive({ version: "v3", auth: client }).about.get({ fields: "user(emailAddress)" });
    const email = data.user?.emailAddress || "";
    await saveAccount({ name: state.name, email, refreshToken: tokens.refresh_token });
    console.log("[gdrive] account connected", { name: state.name, email, admin: state.admin_id });
    return finish(res, returnTo, { gdrive: "connected", account: state.name, email });
  } catch (error) {
    const message = getGoogleErrorReason(error);
    console.error("[gdrive] connect failed", { name: state.name, error: message });
    return finish(res, returnTo, { gdrive: "error", message });
  }
};

exports.setAccountEnabled = async (req, res) => {
  try {
    await setAccountEnabled(req.params.name, req.body?.enabled !== false);
    return exports.getDriveSettings(req, res);
  } catch (error) {
    return sendError(res, error, "Failed to update account");
  }
};

exports.removeAccount = async (req, res) => {
  try {
    await removeAccount(req.params.name);
    return exports.getDriveSettings(req, res);
  } catch (error) {
    return sendError(res, error, "Failed to remove account");
  }
};
