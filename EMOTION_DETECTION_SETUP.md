# Emotion Detection Setup

This server uses face-api.js for real-time face expression detection, using the same logic as the web application.

## Installation

1. Install dependencies:
```bash
npm install
```

This will install:
- `@vladmandic/face-api` - Face detection and landmark detection
- `@tensorflow/tfjs-node` - TensorFlow.js for Node.js
- `canvas` - Canvas implementation for Node.js (already installed)

## Model Files Setup

You need to download the face-api.js model files. The models will be loaded from one of these locations (in order):
1. `server/models/`
2. `web/public/models/` (if web app models exist)
3. `./models/` (root directory)

### Download Models

Download the following model files from the face-api.js repository:
- `tiny_face_detector_model-weights_manifest.json`
- `tiny_face_detector_model-shard1`
- `face_landmark_68_model-weights_manifest.json`
- `face_landmark_68_model-shard1`
- `face_expression_model-weights_manifest.json`
- `face_expression_model-shard1`

You can download them from:
- https://github.com/vladmandic/face-api/tree/master/model
- Or use the web app's models if they're already downloaded

### Quick Setup Script

If you have the web app models, you can create a symlink:
```bash
# On Linux/Mac
ln -s ../web/public/models server/models

# On Windows (PowerShell as Administrator)
New-Item -ItemType SymbolicLink -Path "server/models" -Target "../web/public/models"
```

Or copy the models:
```bash
# Copy from web app if models exist there
cp -r web/public/models server/models
```

## API Endpoints

### POST /api/emotion/detect
Detect emotion from a single image.

**Request:**
```json
{
  "image": "data:image/jpeg;base64,...",
  "session_id": "optional-session-id",
  "use_custom_model": true
}
```

**Response:**
```json
{
  "success": true,
  "landmarks_detected": true,
  "num_landmarks": 68,
  "emotion": "happy",
  "emotionText": "Smiling",
  "customExpression": "Smiling",
  "emotion_confidence": 0.85,
  "clarity_score": 75,
  "clarity_level": "Good",
  "emotions": {
    "happy": 1.0,
    "sad": 0,
    "surprise": 0,
    "angry": 0
  },
  "dominant_emotion": "Happy",
  "expressions": { ... }
}
```

### POST /api/emotion/detect-batch
Detect emotion from multiple images (batch processing).

### GET /api/emotion/health
Check if emotion detection service is available.

## How It Works

1. **Face Detection**: Uses face-api.js TinyFaceDetector to detect faces
2. **Landmark Detection**: Extracts 68 facial landmarks
3. **Expression Analysis**: Uses the same custom expression logic as the web app:
   - Calculates eye aspect ratios (EAR)
   - Analyzes mouth metrics (width, height, curve)
   - Detects eyebrow positions
   - Applies smoothing and calibration
4. **Expression Classification**: Classifies expressions like:
   - Smiling, Laughing, Speaking
   - Winking, Yawning, Surprised
   - Angry, Sleepy, Kissing
   - Neutral

## Performance

- First request: ~2-3 seconds (model loading)
- Subsequent requests: ~200-500ms per image
- Batch processing: Processes images sequentially

## Notes

- Models are loaded lazily on first request
- Session-based smoothing and calibration for better accuracy
- Same expression detection logic as web app for consistency






