const { startDownloadJob, getProgress } = require('../services/ytDownloadService');

exports.startDownload = async (req, res) => {
    try {
        const url = req.query.url;
        const height = req.query.height ? parseInt(req.query.height, 10) : null;
        const asyncJob = req.query.async_job !== 'false';
        // Post to Watch after download when requested (requires auth)
        const postAsWatch = req.query.post_as_watch !== 'false';

        if (!url) {
            return res.status(400).json({ error: 'url query parameter is required' });
        }

        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const profileId = req.profile?._id;

        if (!profileId) {
            return res.status(401).json({
                error: 'Authentication required',
                message: 'Please log in to download videos',
            });
        }

        if (!asyncJob) {
            return res.status(400).json({
                error: 'Synchronous downloads are not supported. Use async_job=true',
            });
        }

        const progressId = startDownloadJob({
            baseUrl,
            url,
            height: Number.isFinite(height) ? height : null,
            postAsWatch,
            profileId,
        });

        return res.status(202).json({
            status: 'accepted',
            progress_id: progressId,
            progress_url: `${baseUrl}/progress/${progressId}`,
            note: 'Job started. Poll progress_url until status=completed to get file_url.',
        });
    } catch (error) {
        console.error('startDownload error:', error);
        return res.status(500).json({ error: error.message || 'Failed to start download' });
    }
};

exports.getProgress = (req, res) => {
    const data = getProgress(req.params.progressId);
    if (!data) {
        return res.status(404).json({ error: 'Progress id not found' });
    }
    return res.json(data);
};
