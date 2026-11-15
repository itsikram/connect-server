// Text-to-speech phone calls through Infobip. The API key comes from the
// environment (INFOBIP_API_KEY); it must never be written in source code.
const INFOBIP_TTS_URL = "https://api.infobip.com/tts/3/advanced";

const isConfigured = () => Boolean(String(process.env.INFOBIP_API_KEY || "").trim());

exports.isConfigured = isConfigured;

exports.phoneCall = (to, from = null, text = null, voice = { name: "Joanna", gender: "female" }) => {
    const apiKey = String(process.env.INFOBIP_API_KEY || "").trim();
    if (!apiKey) {
        console.warn("[phone-call] INFOBIP_API_KEY is not set; call skipped");
        return;
    }
    if (!to) {
        console.warn("[phone-call] no destination number; call skipped");
        return;
    }
    try {
        const sender = from || process.env.INFOBIP_FROM || null;
        const message = {
            destinations: [{ to: String(to) }],
            language: "en",
            text: text || (sender ? "You have a new call from " + sender : "You have a new call"),
            voice,
        };
        if (sender) message.from = String(sender);

        fetch(INFOBIP_TTS_URL, {
            method: "POST",
            headers: {
                Authorization: `App ${apiKey}`,
                "Content-Type": "application/json",
                Accept: "application/json",
            },
            body: JSON.stringify({ messages: [message] }),
            redirect: "follow",
        })
            .then((response) => response.text())
            .then((result) => console.log("[phone-call] infobip response", result))
            .catch((error) => console.error("[phone-call] infobip error", error));
    } catch (error) {
        console.error(error);
    }
};
