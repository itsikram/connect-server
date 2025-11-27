# Download Face-API Models

The emotion detection requires face-api.js model files. Follow these steps:

## Quick Download

### Option 1: Download from GitHub

1. Go to: https://github.com/vladmandic/face-api/tree/master/model
2. Download these 6 files:
   - `tiny_face_detector_model-weights_manifest.json`
   - `tiny_face_detector_model-shard1`
   - `face_landmark_68_model-weights_manifest.json`
   - `face_landmark_68_model-shard1`
   - `face_expression_model-weights_manifest.json`
   - `face_expression_model-shard1`

3. Create the models directory:
   ```bash
   mkdir server/models
   ```

4. Place all 6 files in `server/models/`

### Option 2: Copy from Web App (if available)

If your web app already has models in `web/public/models/`, you can use them:

**Windows (PowerShell):**
```powershell
# Create symbolic link (requires admin)
New-Item -ItemType SymbolicLink -Path "server\models" -Target "..\web\public\models"

# Or copy the folder
Copy-Item -Path "..\web\public\models" -Destination "server\models" -Recurse
```

**Linux/Mac:**
```bash
# Create symbolic link
ln -s ../web/public/models server/models

# Or copy the folder
cp -r ../web/public/models server/models
```

### Option 3: Use npm script (if available)

Some repositories provide npm scripts to download models automatically.

## Verify Installation

After downloading, verify the models are in place:

```bash
cd server
node test-emotion-detection.js
```

You should see:
```
✓ Models loaded successfully
```

## Required Files

Make sure you have these 6 files in `server/models/`:
- ✅ `tiny_face_detector_model-weights_manifest.json`
- ✅ `tiny_face_detector_model-shard1`
- ✅ `face_landmark_68_model-weights_manifest.json`
- ✅ `face_landmark_68_model-shard1`
- ✅ `face_expression_model-weights_manifest.json`
- ✅ `face_expression_model-shard1`

## File Sizes

Typical file sizes:
- `tiny_face_detector_model-shard1`: ~200KB
- `face_landmark_68_model-shard1`: ~1-2MB
- `face_expression_model-shard1`: ~300-500KB

Total: ~2-3MB




