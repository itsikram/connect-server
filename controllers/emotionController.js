const emotionDetection = require('../utils/emotionDetection');

/**
 * Detect emotion from a single image using local face-api.js detection
 * @param {string} imageData - Base64 encoded image (with or without data URI prefix)
 * @param {string} sessionId - Session ID for tracking
 * @param {boolean} useCustomModel - Whether to use custom model (kept for compatibility)
 * @returns {Promise<Object>} Emotion detection result
 */
const detectEmotion = async (imageData, sessionId = 'default', useCustomModel = true) => {
  try {
    // Ensure image data is in correct format
    let processedImageData = imageData;
    if (!imageData.includes(',')) {
      // If no data URI prefix, assume it's base64 and add prefix
      processedImageData = `data:image/jpeg;base64,${imageData}`;
    }

    // Use local emotion detection (same logic as web app)
    const result = await emotionDetection.detectEmotionFromImage(processedImageData, sessionId);

    if (result.error || !result.landmarks_detected) {
      return {
        success: false,
        error: result.error || 'No face detected',
        details: result.error || 'Could not detect a face in the image.',
      };
    }

    return {
      success: true,
      data: result,
    };
  } catch (error) {
    console.error('[EmotionController] Error detecting emotion:', error.message);
    return {
      success: false,
      error: 'Error processing emotion detection',
      details: error.message,
    };
  }
};

/**
 * Detect emotion from multiple images (batch processing)
 * @param {Array<string>} imagesData - Array of base64 encoded images
 * @param {string} sessionId - Session ID for tracking
 * @param {boolean} useCustomModel - Whether to use custom model (kept for compatibility)
 * @returns {Promise<Object>} Emotion detection result
 */
const detectEmotionBatch = async (imagesData, sessionId = 'default', useCustomModel = true) => {
  try {
    // Process images to ensure correct format
    const processedImages = imagesData.map(img => {
      if (!img.includes(',')) {
        return `data:image/jpeg;base64,${img}`;
      }
      return img;
    });

    // Process all images
    const results = [];
    for (const imgData of processedImages) {
      const result = await emotionDetection.detectEmotionFromImage(imgData, sessionId);
      if (result.landmarks_detected) {
        results.push(result);
      }
    }

    if (results.length === 0) {
      return {
        success: false,
        error: 'No faces detected in any image',
        details: 'Could not detect faces in any of the provided images.',
      };
    }

    // Return the most confident result
    const bestResult = results.reduce((best, current) => {
      return (current.emotion_confidence || 0) > (best.emotion_confidence || 0) ? current : best;
    }, results[0]);

    return {
      success: true,
      data: {
        ...bestResult,
        images_processed: results.length,
        batch_analysis: true,
      },
    };
  } catch (error) {
    console.error('[EmotionController] Error detecting emotion (batch):', error.message);
    return {
      success: false,
      error: 'Error processing batch emotion detection',
      details: error.message,
    };
  }
};

/**
 * Health check for emotion detection service
 * @returns {Promise<Object>} Service health status
 */
const checkEmotionServerHealth = async () => {
  try {
    // Check if models are loaded
    await emotionDetection.loadModels();
    return {
      success: true,
      status: 'healthy',
      message: 'Emotion detection service is ready',
    };
  } catch (error) {
    return {
      success: false,
      status: 'unavailable',
      error: error.message,
      message: 'Emotion detection service is not available',
    };
  }
};

module.exports = {
  detectEmotion,
  detectEmotionBatch,
  checkEmotionServerHealth,
};

