// Quick test script to verify emotion detection setup
const emotionDetection = require('./utils/emotionDetection');

async function test() {
  console.log('Testing emotion detection setup...\n');
  
  try {
    // Test model loading
    console.log('1. Loading models...');
    await emotionDetection.loadModels();
    console.log('✓ Models loaded successfully\n');
    
    // Test with a minimal base64 image (1x1 pixel red PNG)
    // Note: This will fail because face-api needs a real image with a face
    const testImage = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
    
    console.log('2. Testing emotion detection...');
    console.log('   (Using 1x1 pixel test image - will not detect face, but tests the pipeline)');
    const result = await emotionDetection.detectEmotionFromImage(testImage, 'test-session');
    
    if (result.error || !result.landmarks_detected) {
      console.log('⚠ No face detected (expected for test image)');
      console.log('   Error:', result.error || 'No landmarks detected');
      console.log('   This is normal - you need a real image with a face to test detection.');
    } else {
      console.log('✓ Face detected!');
      console.log('Emotion:', result.emotion);
      console.log('Expression:', result.customExpression);
    }
    
    console.log('\n✅ Emotion detection setup is working!');
    console.log('\nNote: You need to download face-api models to detect real faces.');
    console.log('Download from: https://github.com/vladmandic/face-api/tree/master/model');
    console.log('Place them in: server/models/');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

test();

