const axios = require('axios');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const getFallbackBaseUrl = () =>
    (process.env.YT_DL_FALLBACK_URL || 'https://yt-dl-ufvy.onrender.com').replace(/\/$/, '');

const downloadViaFallbackApi = async ({ url, height, onProgress }) => {
    const base = getFallbackBaseUrl();
    const encoded = encodeURIComponent(url);
    const heightParam = height ? `&height=${height}` : '';
    const startUrl = `${base}/download?url=${encoded}&ext=mp4${heightParam}&disposition=inline&link_only=true&async_job=true`;

    let startRes;
    try {
        startRes = await axios.get(startUrl, {
            headers: { Accept: 'application/json' },
            timeout: 60000,
            validateStatus: (status) => status < 500,
        });
    } catch (err) {
        throw new Error(`YouTube fallback service unreachable (${base}): ${err.message}`);
    }

    if (startRes.status === 404) {
        throw new Error(
            `YouTube fallback service not found at ${base}. Deploy the ytv-dl app on Render or set YT_DL_FALLBACK_URL to a working service URL.`
        );
    }

    if (startRes.status !== 202 && startRes.status !== 200) {
        throw new Error(`YouTube fallback service error (${startRes.status}): ${startRes.data?.error || startRes.data || 'Unknown error'}`);
    }

    const progressUrl = startRes.data?.progress_url;
    if (!progressUrl) {
        throw new Error('Fallback service did not return a progress URL');
    }

    const maxAttempts = 300;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
        await sleep(2000);

        const progRes = await axios.get(progressUrl, {
            headers: { Accept: 'application/json' },
            params: { _ts: Date.now() },
            timeout: 30000,
        });

        const data = progRes.data || {};
        const pct = data.pct || 0;
        const stage = data.stage || 'downloading';

        if (typeof onProgress === 'function') {
            onProgress({ pct, stage, title: data.title || data.download_title });
        }

        if (data.status === 'completed' && data.file_url) {
            return {
                fileUrl: data.file_url,
                title: data.title || data.download_title || 'video',
            };
        }

        if (data.status === 'failed' || data.status === 'error') {
            throw new Error(data.error || 'Fallback download failed');
        }
    }

    throw new Error('Fallback download timed out');
};

module.exports = {
    downloadViaFallbackApi,
};
