const express = require('express');
const SavedVideo = require('../models/SavedVideo');
const isAuth = require('../middlewares/isAuth');

const router = express.Router();

const normalizeMetadata = (metadata) => {
  if (!metadata || typeof metadata !== 'object') return {};

  const safe = { ...metadata };

  // These fields come in different shapes across sources (string/number/array/object)
  // Keep them flexible to avoid cast failures.
  safe.likes = safe.likes ?? '';
  safe.comments = safe.comments ?? '';
  safe.shares = safe.shares ?? '';
  safe.playCount = safe.playCount ?? '';

  return safe;
};

const extractSourceUrl = (metadata, sourceUrl) => {
  const direct = typeof sourceUrl === 'string' ? sourceUrl.trim() : '';
  if (direct) return direct;

  const candidates = [
    metadata?.videoURL,
    metadata?.videoUrl,
    metadata?.url,
    metadata?.downloadUrl,
    metadata?.downloadURL,
    metadata?.mediaUrl,
    metadata?.mediaURL,
    metadata?.video?.url,
  ];

  return String(candidates.find((v) => typeof v === 'string' && v.trim()) || '').trim();
};

/**
 * Save video to database history
 * POST /api/saved-videos/save
 */
router.post('/save', isAuth, async (req, res) => {
  try {
    const { videoId, metadata, sourceUrl } = req.body;
    const safeMetadata = normalizeMetadata(metadata);
    const canonicalSourceUrl = extractSourceUrl(safeMetadata, sourceUrl);
    if (canonicalSourceUrl && !safeMetadata.videoURL) {
      safeMetadata.videoURL = canonicalSourceUrl;
    }
    // Get userId from profile (which is populated by isAuth middleware)
    const userId = req.profile?.user?._id;

    console.log('[SavedVideo] Save request:', {
      videoId,
      hasMetadata: !!metadata,
      hasSourceUrl: !!canonicalSourceUrl,
      userId: userId?.toString(),
    });

    if (!userId || !videoId) {
      console.error('[SavedVideo] ❌ Missing userId or videoId', {
        userId: !!userId,
        videoId: !!videoId,
      });
      return res.status(400).json({
        success: false,
        error: 'Missing userId or videoId',
      });
    }

    // Upsert: update if exists, create if doesn't
    const savedVideo = await SavedVideo.findOneAndUpdate(
      { userId, videoId: String(videoId) },
      {
        userId,
        videoId: String(videoId),
        metadata: safeMetadata,
        status: 'active',
        sourceUrl: canonicalSourceUrl,
        downloadedAt: new Date(),
      },
      { upsert: true, new: true }
    );

    console.log('[SavedVideo] ✓ Video saved successfully:', {
      videoId: savedVideo.videoId,
      userId: savedVideo.userId?.toString(),
      _id: savedVideo._id?.toString(),
    });

    res.status(200).json({
      success: true,
      message: 'Video saved to history',
      data: savedVideo,
    });
  } catch (error) {
    console.error('[SavedVideo] ❌ Error saving video:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to save video',
    });
  }
});

/**
 * Get all saved videos history for current user
 * GET /api/saved-videos/history
 */
router.get('/history', isAuth, async (req, res) => {
  try {
    // Get userId from profile (which is populated by isAuth middleware)
    const userId = req.profile?.user?._id;

    console.log('[SavedVideo] History request for user:', userId?.toString());

    if (!userId) {
      console.error('[SavedVideo] ❌ No userId in profile');
      return res.status(400).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    const savedVideos = await SavedVideo.find({
      userId,
      status: 'active',
    })
      .populate('userId', 'email firstName surname')
      .sort({ downloadedAt: -1 });

    console.log('[SavedVideo] ✓ Found videos:', {
      count: savedVideos.length,
      userId: userId.toString(),
    });

    res.status(200).json({
      success: true,
      data: savedVideos,
      count: savedVideos.length,
    });
  } catch (error) {
    console.error('[SavedVideo] ❌ Error fetching videos:', {
      message: error.message,
      stack: error.stack,
    });
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to fetch saved videos',
    });
  }
});

/**
 * Delete video from history
 * DELETE /api/saved-videos/:videoId
 */
router.delete('/:videoId', isAuth, async (req, res) => {
  try {
    const userId = req.profile?.user?._id;
    const { videoId } = req.params;

    console.log('[SavedVideo] Delete request:', { videoId, userId: userId?.toString() });

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    const result = await SavedVideo.findOneAndUpdate(
      { userId, videoId: String(videoId) },
      { status: 'deleted' },
      { new: true }
    );

    if (!result) {
      console.log('[SavedVideo] Video not found:', { videoId, userId: userId.toString() });
      return res.status(404).json({
        success: false,
        error: 'Video not found',
      });
    }

    console.log('[SavedVideo] ✓ Video deleted:', videoId);

    res.status(200).json({
      success: true,
      message: 'Video removed from history',
    });
  } catch (error) {
    console.error('[SavedVideo] ❌ Error deleting video:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete video',
    });
  }
});

/**
 * Batch delete videos
 * POST /api/saved-videos/batch-delete
 */
router.post('/batch-delete', isAuth, async (req, res) => {
  try {
    const userId = req.profile?.user?._id;
    const { videoIds } = req.body;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    if (!Array.isArray(videoIds) || videoIds.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid videoIds',
      });
    }

    const result = await SavedVideo.updateMany(
      { userId, videoId: { $in: videoIds.map(String) } },
      { status: 'deleted' }
    );

    console.log('[SavedVideo] ✓ Batch deleted:', { count: result.modifiedCount });

    res.status(200).json({
      success: true,
      message: `${result.modifiedCount} videos removed from history`,
    });
  } catch (error) {
    console.error('[SavedVideo] ❌ Error batch deleting videos:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to delete videos',
    });
  }
});

/**
 * Clear all saved videos history
 * DELETE /api/saved-videos/clear-all
 */
router.delete('/clear-all', isAuth, async (req, res) => {
  try {
    const userId = req.profile?.user?._id;

    if (!userId) {
      return res.status(400).json({
        success: false,
        error: 'User not authenticated',
      });
    }

    const result = await SavedVideo.updateMany(
      { userId },
      { status: 'deleted' }
    );

    console.log('[SavedVideo] ✓ Cleared all videos:', { count: result.modifiedCount });

    res.status(200).json({
      success: true,
      message: 'All videos removed from history',
    });
  } catch (error) {
    console.error('[SavedVideo] ❌ Error clearing videos:', error.message);
    res.status(500).json({
      success: false,
      error: error.message || 'Failed to clear videos',
    });
  }
});

module.exports = router;
