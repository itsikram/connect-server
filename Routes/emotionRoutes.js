const express = require('express');
const router = express.Router();
const emotionController = require('../controllers/emotionController');

/**
 * @route   POST /api/emotion/detect
 * @desc    Detect emotion from a single image
 * @access  Public (can add auth middleware if needed)
 * @body    { image: string (base64), session_id?: string, use_custom_model?: boolean }
 */
router.post('/detect', async (req, res) => {
  try {
    const { image, session_id, use_custom_model } = req.body;

    if (!image) {
      return res.status(400).json({
        success: false,
        error: 'Image is required',
        message: 'Please provide a base64 encoded image in the request body.',
      });
    }

    const sessionId = session_id || req.headers['x-session-id'] || 'default';
    const useCustomModel = use_custom_model !== undefined ? use_custom_model : true;

    const result = await emotionController.detectEmotion(image, sessionId, useCustomModel);

    if (result.success) {
      return res.status(200).json({
        success: true,
        ...result.data,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        details: result.details,
      });
    }
  } catch (error) {
    console.error('[EmotionRoutes] Error in /detect:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  }
});

/**
 * @route   POST /api/emotion/detect-batch
 * @desc    Detect emotion from multiple images (batch processing)
 * @access  Public
 * @body    { images: string[], session_id?: string, use_custom_model?: boolean }
 */
router.post('/detect-batch', async (req, res) => {
  try {
    const { images, session_id, use_custom_model } = req.body;

    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Images array is required',
        message: 'Please provide an array of base64 encoded images in the request body.',
      });
    }

    const sessionId = session_id || req.headers['x-session-id'] || 'default';
    const useCustomModel = use_custom_model !== undefined ? use_custom_model : true;

    const result = await emotionController.detectEmotionBatch(images, sessionId, useCustomModel);

    if (result.success) {
      return res.status(200).json({
        success: true,
        ...result.data,
      });
    } else {
      return res.status(500).json({
        success: false,
        error: result.error,
        details: result.details,
      });
    }
  } catch (error) {
    console.error('[EmotionRoutes] Error in /detect-batch:', error);
    return res.status(500).json({
      success: false,
      error: 'Internal server error',
      details: error.message,
    });
  }
});

/**
 * @route   GET /api/emotion/health
 * @desc    Check if emotion detection server is available
 * @access  Public
 */
router.get('/health', async (req, res) => {
  try {
    const healthStatus = await emotionController.checkEmotionServerHealth();
    
    if (healthStatus.success) {
      return res.status(200).json({
        success: true,
        status: 'healthy',
        server: 'emotion-detection',
        ...healthStatus,
      });
    } else {
      return res.status(503).json({
        success: false,
        status: 'unavailable',
        server: 'emotion-detection',
        error: healthStatus.error,
      });
    }
  } catch (error) {
    console.error('[EmotionRoutes] Error in /health:', error);
    return res.status(500).json({
      success: false,
      status: 'error',
      error: error.message,
    });
  }
});

module.exports = router;






