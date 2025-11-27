const { createCanvas, loadImage } = require('canvas');
const path = require('path');
const fs = require('fs');
const Module = require('module');

// Create a module stub for @tensorflow/tfjs-node before face-api tries to load it
// This allows face-api to work with CPU-only TensorFlow.js
const originalRequire = Module.prototype.require;

// Intercept require calls to redirect @tensorflow/tfjs-node to CPU-only version
Module.prototype.require = function(id) {
  if (id === '@tensorflow/tfjs-node') {
    try {
      // Try to load the actual module first
      return originalRequire.apply(this, arguments);
    } catch (e) {
      // If not available, return CPU-only version
      console.log('[EmotionDetection] @tensorflow/tfjs-node not available, using CPU-only backend');
      return require('@tensorflow/tfjs');
    }
  }
  return originalRequire.apply(this, arguments);
};

// Load TensorFlow.js (CPU-only version)
const tf = require('@tensorflow/tfjs');

// Now load face-api - it will get the CPU-only version via our require interceptor
const faceapi = require('@vladmandic/face-api');

// Note: We keep the interceptor active since face-api might need tfjs-node later during runtime
// The interceptor will provide CPU-only version whenever tfjs-node is requested

// Initialize face-api models (lazy load)
let modelsLoaded = false;
let loadingPromise = null;
let preloadPromise = null; // For server startup preloading

/**
 * Load face-api models
 */
async function loadModels() {
  if (modelsLoaded) return;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    try {
      // Models are stored in face-api-models directory
      const modelsPath = path.join(__dirname, '../face-api-models');
      
      // Check if models directory exists, if not, try alternative locations
      let actualModelsPath = modelsPath;
      if (!fs.existsSync(modelsPath)) {
        // Try alternative locations
        const altPaths = [
          path.join(__dirname, '../face-api-models'),
          path.join(__dirname, '../models'),
          path.join(__dirname, '../../web/public/models'),
          './face-api-models',
          './models',
        ];
        for (const altPath of altPaths) {
          if (fs.existsSync(altPath)) {
            actualModelsPath = altPath;
            break;
          }
        }
      }

      console.log('[EmotionDetection] Loading face-api models from:', actualModelsPath);

      // Check if models directory exists
      if (!fs.existsSync(actualModelsPath)) {
        throw new Error(
          `Models directory not found at: ${actualModelsPath}\n` +
          `Please download face-api.js models from: https://github.com/vladmandic/face-api/tree/master/model\n` +
          `Place the model files in: ${actualModelsPath}`
        );
      }

      // Register canvas for face-api
      const { ImageData } = require('canvas');
      
      // Set up TensorFlow.js backend
      try {
        // Try to use CPU backend explicitly
        await tf.setBackend('cpu');
        await tf.ready();
        console.log('[EmotionDetection] TensorFlow.js backend:', tf.getBackend());
      } catch (e) {
        console.warn('[EmotionDetection] Could not set CPU backend, using default:', e.message);
        await tf.ready();
      }
      
      // Monkey patch face-api to use canvas
      faceapi.env.monkeyPatch({ 
        Canvas: createCanvas, 
        Image: loadImage, 
        ImageData,
      });

      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromDisk(actualModelsPath),
        faceapi.nets.faceLandmark68Net.loadFromDisk(actualModelsPath),
        faceapi.nets.faceExpressionNet.loadFromDisk(actualModelsPath),
      ]);

      modelsLoaded = true;
      console.log('[EmotionDetection] Face-api models loaded successfully');
    } catch (error) {
      console.error('[EmotionDetection] Error loading models:', error);
      throw error;
    }
  })();

  return loadingPromise;
}

// Distance between two points
function distance(p1, p2) {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  const dz = (p1.z || 0) - (p2.z || 0);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

// Calculate face clarity score (adapted from MediaPipe logic)
function calculateFaceClarity(landmarks, imageWidth, imageHeight) {
  // face-api provides 68 landmarks, we need to map to key points
  // Left eye outer: ~36, Right eye outer: ~45
  const leftEyeOuter = landmarks.positions[36];
  const rightEyeOuter = landmarks.positions[45];
  
  if (!leftEyeOuter || !rightEyeOuter) {
    return { score: 50, level: 'Fair' };
  }

  const faceWidth = distance(leftEyeOuter, rightEyeOuter);
  const faceWidthNormalized = faceWidth / Math.max(imageWidth, imageHeight);

  let sizeScore = 0;
  if (faceWidthNormalized >= 0.18 && faceWidthNormalized <= 0.38) {
    sizeScore = 100 - Math.abs(faceWidthNormalized - 0.28) * 300;
  } else if (faceWidthNormalized < 0.18) {
    sizeScore = Math.max(0, (faceWidthNormalized / 0.18) * 60);
  } else {
    sizeScore = Math.max(0, 60 - (faceWidthNormalized - 0.38) * 300);
  }

  // Nose tip: ~30, Left cheek: ~1, Right cheek: ~15
  const nose = landmarks.positions[30];
  const leftCheek = landmarks.positions[1];
  const rightCheek = landmarks.positions[15];

  let angleScore = 100;
  if (nose && leftCheek && rightCheek) {
    const leftDepth = Math.abs((nose.z || 0) - (leftCheek.z || 0));
    const rightDepth = Math.abs((nose.z || 0) - (rightCheek.z || 0));
    const depthDifference = Math.abs(leftDepth - rightDepth);
    angleScore = Math.max(0, 100 - depthDifference * 1000);
  }

  const faceCenterX = (leftEyeOuter.x + rightEyeOuter.x) / 2;
  const horizontalCenter = Math.abs(faceCenterX / imageWidth - 0.5);
  const centerScore = Math.max(0, 100 - horizontalCenter * 300);

  const faceCenterY = nose ? nose.y : (leftEyeOuter.y + rightEyeOuter.y) / 2;
  const verticalScore = (faceCenterY / imageHeight >= 0.3 && faceCenterY / imageHeight <= 0.6) 
    ? 100 
    : Math.max(0, 100 - Math.abs(faceCenterY / imageHeight - 0.45) * 300);

  const clarityScore = (sizeScore * 0.4 + angleScore * 0.3 + centerScore * 0.2 + verticalScore * 0.1);
  let clarityLevel = 'Poor';
  if (clarityScore >= 80) clarityLevel = 'Excellent';
  else if (clarityScore >= 65) clarityLevel = 'Good';
  else if (clarityScore >= 50) clarityLevel = 'Fair';

  return { score: Math.round(clarityScore), level: clarityLevel };
}

// Exponential moving average helper
function ema(prev, next, alpha) {
  return (prev === undefined || prev === null) ? next : (prev * (1 - alpha) + next * alpha);
}

// Session storage for smoothing and calibration (per session)
const sessionContexts = {};

function getSessionContext(sessionId) {
  if (!sessionContexts[sessionId]) {
    sessionContexts[sessionId] = {
      smoothCtx: {},
      calibCtx: {
        isCalibrating: true,
        framesCollected: 0,
        sums: { avgEAR: 0, mouthWidth: 0, mar: 0, innerBrowDistance: 0, browRatio: 0, mouthCurve: 0 },
        baseline: null,
      },
    };
  }
  return sessionContexts[sessionId];
}

// Map face-api 68 landmarks to MediaPipe-style indices for expression analysis
// face-api landmarks: https://github.com/justadudewhohacks/face-api.js#face-landmarks
function mapLandmarksForExpression(landmarks) {
  const positions = landmarks.positions;
  
  // Map key points (face-api 68-point model)
  // Eyes: 36-47 (left), 42-47 (right)
  // Nose: 27-35
  // Mouth: 48-67
  // Eyebrows: 17-26
  
  return {
    // Eye points (approximate MediaPipe indices)
    leftEyeTop: positions[37] || positions[38],
    leftEyeBottom: positions[41] || positions[40],
    leftEyeOuter: positions[36],
    rightEyeTop: positions[43] || positions[44],
    rightEyeBottom: positions[47] || positions[46],
    rightEyeOuter: positions[45],
    
    // Mouth points
    mouthTop: positions[51] || positions[62],
    mouthBottom: positions[57] || positions[66],
    mouthLeft: positions[48],
    mouthRight: positions[54],
    leftCorner: positions[48],
    rightCorner: positions[54],
    
    // Eyebrow points
    leftEyebrowInner: positions[21],
    rightEyebrowInner: positions[22],
    leftEyebrowCenter: positions[19],
    rightEyebrowCenter: positions[24],
    
    // Nose
    nose: positions[30],
    
    // Lips
    upperLip: positions[51],
    lowerLip: positions[57],
  };
}

// Analyze expression using the same logic as web app (adapted for face-api landmarks)
function analyzeExpression(landmarks, clarityScore, imageWidth, imageHeight, smoothCtx, calibCtx) {
  const SMOOTH_ALPHA = 0.35;
  const mapped = mapLandmarksForExpression(landmarks);
  
  // Face size for normalization
  const leftEyeOuter = mapped.leftEyeOuter;
  const rightEyeOuter = mapped.rightEyeOuter;
  if (!leftEyeOuter || !rightEyeOuter) {
    return { customExpression: 'Neutral', emotions: {}, dominantEmotion: 'Neutral', dominantEmotionScore: 0.25 };
  }

  const faceWidth = distance(leftEyeOuter, rightEyeOuter);
  const faceWidthPx = Math.hypot(
    (leftEyeOuter.x - rightEyeOuter.x),
    (leftEyeOuter.y - rightEyeOuter.y)
  );

  // Eye aspect ratios
  const leftEyeTop = mapped.leftEyeTop;
  const leftEyeBottom = mapped.leftEyeBottom;
  const rightEyeTop = mapped.rightEyeTop;
  const rightEyeBottom = mapped.rightEyeBottom;
  
  if (!leftEyeTop || !leftEyeBottom || !rightEyeTop || !rightEyeBottom) {
    return { customExpression: 'Neutral', emotions: {}, dominantEmotion: 'Neutral', dominantEmotionScore: 0.25 };
  }

  const leftEAR = distance(leftEyeTop, leftEyeBottom) / faceWidth;
  const rightEAR = distance(rightEyeTop, rightEyeBottom) / faceWidth;
  const avgEAR_raw = (leftEAR + rightEAR) / 2;

  // Mouth metrics
  const mouthTop = mapped.mouthTop;
  const mouthBottom = mapped.mouthBottom;
  const mouthLeft = mapped.mouthLeft;
  const mouthRight = mapped.mouthRight;
  
  if (!mouthTop || !mouthBottom || !mouthLeft || !mouthRight) {
    return { customExpression: 'Neutral', emotions: {}, dominantEmotion: 'Neutral', dominantEmotionScore: 0.25 };
  }

  const mouthHeight_raw = distance(mouthTop, mouthBottom) / faceWidth;
  const mouthWidth_raw = distance(mouthLeft, mouthRight) / faceWidth;
  const mar_raw = mouthHeight_raw / mouthWidth_raw;

  // Mouth curve
  const leftCorner = mapped.leftCorner;
  const rightCorner = mapped.rightCorner;
  const mouthCenterY = mouthTop.y;
  const cornerHeightAvg = (leftCorner.y + rightCorner.y) / 2;
  const mouthCurve_raw = mouthCenterY - cornerHeightAvg;

  // Brows
  const leftEyebrowInner = mapped.leftEyebrowInner;
  const rightEyebrowInner = mapped.rightEyebrowInner;
  const leftEyebrowCenter = mapped.leftEyebrowCenter;
  const rightEyebrowCenter = mapped.rightEyebrowCenter;
  
  if (!leftEyebrowInner || !rightEyebrowInner || !leftEyebrowCenter || !rightEyebrowCenter) {
    return { customExpression: 'Neutral', emotions: {}, dominantEmotion: 'Neutral', dominantEmotionScore: 0.25 };
  }

  const innerBrowDistance_raw = distance(leftEyebrowInner, rightEyebrowInner) / faceWidth;
  const innerBrowDistance_px = Math.hypot(
    (leftEyebrowInner.x - rightEyebrowInner.x),
    (leftEyebrowInner.y - rightEyebrowInner.y)
  );
  const leftBrowToEye = distance(leftEyebrowInner, leftEyeTop) / faceWidth;
  const rightBrowToEye = distance(rightEyebrowInner, rightEyeTop) / faceWidth;
  const avgBrowToEye = (leftBrowToEye + rightBrowToEye) / 2;
  
  // Approximate eye width from landmarks
  const leftEyeWidth = distance(landmarks.positions[36], landmarks.positions[39]) / faceWidth;
  const rightEyeWidth = distance(landmarks.positions[42], landmarks.positions[45]) / faceWidth;
  const avgEyeWidth = (leftEyeWidth + rightEyeWidth) / 2;
  const browRatio_raw = avgBrowToEye / avgEyeWidth;

  // Lip distance
  const upperLip = mapped.upperLip;
  const lowerLip = mapped.lowerLip;
  const lipDistance_raw = upperLip && lowerLip ? distance(upperLip, lowerLip) / faceWidth : 0;

  // Smooth key features
  smoothCtx.avgEAR = ema(smoothCtx.avgEAR, avgEAR_raw, SMOOTH_ALPHA);
  smoothCtx.mouthWidth = ema(smoothCtx.mouthWidth, mouthWidth_raw, SMOOTH_ALPHA);
  smoothCtx.mar = ema(smoothCtx.mar, mar_raw, SMOOTH_ALPHA);
  smoothCtx.mouthHeight = ema(smoothCtx.mouthHeight, mouthHeight_raw, SMOOTH_ALPHA);
  smoothCtx.mouthCurve = ema(smoothCtx.mouthCurve, mouthCurve_raw, SMOOTH_ALPHA);
  smoothCtx.innerBrowDistance = ema(smoothCtx.innerBrowDistance, innerBrowDistance_raw, SMOOTH_ALPHA);
  smoothCtx.browRatio = ema(smoothCtx.browRatio, browRatio_raw, SMOOTH_ALPHA);
  smoothCtx.lipDistance = ema(smoothCtx.lipDistance, lipDistance_raw, SMOOTH_ALPHA);

  // Calibration
  if (calibCtx.isCalibrating && clarityScore >= 65) {
    calibCtx.framesCollected++;
    calibCtx.sums.avgEAR += (smoothCtx.avgEAR || avgEAR_raw);
    calibCtx.sums.mouthWidth += (smoothCtx.mouthWidth || mouthWidth_raw);
    calibCtx.sums.mar += (smoothCtx.mar || mar_raw);
    calibCtx.sums.innerBrowDistance += (smoothCtx.innerBrowDistance || innerBrowDistance_raw);
    calibCtx.sums.browRatio += (smoothCtx.browRatio || browRatio_raw);
    calibCtx.sums.mouthCurve += (smoothCtx.mouthCurve || mouthCurve_raw);
    if (calibCtx.framesCollected >= 45) {
      calibCtx.baseline = {
        avgEAR: calibCtx.sums.avgEAR / calibCtx.framesCollected,
        mouthWidth: calibCtx.sums.mouthWidth / calibCtx.framesCollected,
        mar: calibCtx.sums.mar / calibCtx.framesCollected,
        innerBrowDistance: calibCtx.sums.innerBrowDistance / calibCtx.framesCollected,
        browRatio: calibCtx.sums.browRatio / calibCtx.framesCollected,
        mouthCurve: calibCtx.sums.mouthCurve / calibCtx.framesCollected,
      };
      calibCtx.isCalibrating = false;
    }
  }

  // Expression detection (same logic as web app)
  const mouthOpenArea = (smoothCtx.mar || mar_raw) * (smoothCtx.mouthWidth || mouthWidth_raw);
  const teethVisible = ((smoothCtx.mar || mar_raw) > 0.22 && (smoothCtx.mouthHeight || mouthHeight_raw) > 0.03) || mouthOpenArea > 0.035;

  const mouthWidthVal = parseFloat((smoothCtx.mouthWidth || mouthWidth_raw).toFixed(4));
  const mouthOpenAreaVal = parseFloat(mouthOpenArea.toFixed(4));
  const avgEARVal = parseFloat((smoothCtx.avgEAR || avgEAR_raw).toFixed(4));
  const browDistanceRatioVal = innerBrowDistance_px / faceWidthPx;
  const innerBrowDistanceVal = parseFloat((smoothCtx.innerBrowDistance || innerBrowDistance_raw).toFixed(4));
  const mouthCurveVal = parseFloat((smoothCtx.mouthCurve || mouthCurve_raw).toFixed(4));
  const leftBrowToEyeVal = parseFloat(leftBrowToEye.toFixed(4));
  const rightBrowToEyeVal = parseFloat(rightBrowToEye.toFixed(4));
  const mouthHeightVal = parseFloat((smoothCtx.mouthHeight || mouthHeight_raw).toFixed(4));

  // Custom expression detection (exact same logic as web app)
  let customExpression = 'Neutral';
  if (mouthWidthVal > 0.57 && !teethVisible) {
    customExpression = 'Smiling';
  } else if (mouthWidthVal > 0.60 && teethVisible && mouthOpenAreaVal > 0.18) {
    customExpression = 'Laughing';
  } else if (teethVisible && mouthCurveVal > -0.25 && mouthOpenAreaVal < 0.20) {
    customExpression = 'Speaking';
  } else if (leftEAR < 0.05 && rightEAR > 0.05 && mouthOpenAreaVal < 0.30) {
    customExpression = 'Winking';
  } else if (leftEAR > 0.05 && rightEAR < 0.05 && mouthOpenAreaVal < 0.30) {
    customExpression = 'Winking';
  } else if (mouthOpenAreaVal > 0.40 && avgEARVal < 0.11) {
    customExpression = 'Yawning';
  } else if (browDistanceRatioVal > 0.310 && innerBrowDistanceVal > 0.305) {
    customExpression = 'Surprised';
  } else if (browDistanceRatioVal < 0.305 && innerBrowDistanceVal < 0.290 && mouthOpenAreaVal < 0.30) {
    customExpression = 'Angry';
  } else if (avgEARVal < 0.095 && mouthCurveVal > -0.150 && mouthOpenAreaVal < 0.25 && leftEAR > 0.05 && rightEAR > 0.05) {
    customExpression = 'Sleepy';
  } else if (leftBrowToEyeVal > 0.595 || rightBrowToEyeVal > 0.595) {
    customExpression = 'Eyebrow Raise';
  } else if (mouthHeightVal < 0.045 && mouthWidthVal < 0.43 && mouthCurveVal > 0.0) {
    customExpression = 'Kissing';
  }

  // Emotion scoring
  function computeEmotionScores(exprLabel) {
    const scores = { happy: 0, sad: 0, surprise: 0, angry: 0 };
    switch (exprLabel) {
      case 'Smiling': scores.happy = 1.0; break;
      case 'Laughing': scores.happy = 1.0; scores.surprise = 0.2; break;
      case 'Winking': scores.happy = 0.4; break;
      case 'Yawning': scores.surprise = 0.8; break;
      case 'Eyebrow Raise': scores.surprise = 0.8; break;
      case 'Sleepy': scores.sad = 0.5; break;
      case 'Speaking': scores.happy = 0.2; scores.surprise = 0.2; break;
      default: scores.happy = 0.25; scores.sad = 0.25; scores.surprise = 0.25; scores.angry = 0.25; break;
    }
    return scores;
  }

  const emotions = computeEmotionScores(customExpression);
  let dominantEmotion = 'Neutral';
  let dominantScore = -1;
  for (const k of ['happy', 'sad', 'surprise', 'angry']) {
    if (emotions[k] > dominantScore) {
      dominantScore = emotions[k];
      dominantEmotion = k.charAt(0).toUpperCase() + k.slice(1);
    }
  }

  return {
    customExpression,
    emotions,
    dominantEmotion,
    dominantEmotionScore: dominantScore,
  };
}

/**
 * Detect emotion from base64 image
 */
async function detectEmotionFromImage(base64Image, sessionId = 'default') {
  try {
    // Ensure models are loaded
    await loadModels();

    // Decode base64 image
    let imageData = base64Image;
    if (imageData.includes(',')) {
      imageData = imageData.split(',')[1];
    }
    const imageBuffer = Buffer.from(imageData, 'base64');

    // Load image
    const img = await loadImage(imageBuffer);
    
    // Store original dimensions for clarity calculation
    const originalWidth = img.width;
    const originalHeight = img.height;
    
    // OPTIMIZATION: Resize image to max 320x320 for faster processing
    // This significantly speeds up face detection without losing accuracy for real-time use
    const MAX_SIZE = 320;
    let processedImg;
    
    if (img.width > MAX_SIZE || img.height > MAX_SIZE) {
      const scale = Math.min(MAX_SIZE / img.width, MAX_SIZE / img.height);
      const newWidth = Math.round(img.width * scale);
      const newHeight = Math.round(img.height * scale);
      
      const resizedCanvas = createCanvas(newWidth, newHeight);
      const ctx = resizedCanvas.getContext('2d');
      ctx.drawImage(img, 0, 0, newWidth, newHeight);
      processedImg = resizedCanvas;
    } else {
      // Use face-api's createCanvasFromMedia to ensure compatibility
      processedImg = faceapi.createCanvasFromMedia(img);
    }
    
    // OPTIMIZATION: Use smaller input size and faster score threshold for real-time processing
    // TinyFaceDetector with inputSize 128 is much faster than 416 (3-4x speedup)
    const detections = await faceapi
      .detectAllFaces(processedImg, new faceapi.TinyFaceDetectorOptions({
        inputSize: 128,  // Reduced from 416 for faster detection (real-time optimized)
        scoreThreshold: 0.35,  // Lower threshold for better detection at smaller size
      }))
      .withFaceLandmarks()  // Use standard landmark detector (68 points for accuracy)
      .withFaceExpressions();

    if (detections.length === 0) {
      return {
        landmarks_detected: false,
        num_landmarks: 0,
        error: 'No face detected',
      };
    }

    const detection = detections[0];
    const landmarks = detection.landmarks;
    const expressions = detection.expressions;

    // Get session context for smoothing
    const sessionCtx = getSessionContext(sessionId);
    const { smoothCtx, calibCtx } = sessionCtx;

    // Calculate clarity (using original dimensions for accurate scoring)
    const clarity = calculateFaceClarity(landmarks, originalWidth, originalHeight);

    // Analyze expression using custom logic
    const analysis = analyzeExpression(
      landmarks,
      clarity.score,
      img.width,
      img.height,
      smoothCtx,
      calibCtx
    );

    // Map custom expression to emotion name
    const emotionMap = {
      'Smiling': 'happy',
      'Laughing': 'happy',
      'Winking': 'happy',
      'Speaking': 'neutral',
      'Yawning': 'surprised',
      'Surprised': 'surprised',
      'Eyebrow Raise': 'surprised',
      'Angry': 'angry',
      'Sleepy': 'sad',
      'Kissing': 'happy',
      'Neutral': 'neutral',
    };

    const emotion = emotionMap[analysis.customExpression] || 'neutral';
    const emotionConfidence = Math.max(
      analysis.dominantEmotionScore,
      expressions ? Math.max(...Object.values(expressions)) : 0.5
    );

    return {
      landmarks_detected: true,
      num_landmarks: landmarks.positions.length,
      emotion,
      emotionText: analysis.customExpression,
      customExpression: analysis.customExpression,
      emotion_confidence: emotionConfidence,
      confidence: emotionConfidence,
      clarity_score: clarity.score,
      clarity_level: clarity.level,
      emotions: analysis.emotions,
      dominant_emotion: analysis.dominantEmotion,
      expressions: expressions || {},
      method: 'face-api-custom',
    };
  } catch (error) {
    console.error('[EmotionDetection] Error detecting emotion:', error);
    return {
      landmarks_detected: false,
      error: error.message,
    };
  }
}

/**
 * Preload models at server startup for faster first request
 * This should be called when the server starts
 */
async function preloadModels() {
  if (modelsLoaded) return;
  if (preloadPromise) return preloadPromise;
  
  preloadPromise = loadModels().catch(err => {
    console.error('[EmotionDetection] Failed to preload models:', err);
    preloadPromise = null; // Allow retry
    throw err;
  });
  
  return preloadPromise;
}

module.exports = {
  detectEmotionFromImage,
  loadModels,
  preloadModels,
};

