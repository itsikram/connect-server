# Installing Face-API Dependencies (Windows)

Due to Windows compatibility issues with native TensorFlow bindings, we'll use the CPU-only version of TensorFlow.js which doesn't require Visual Studio build tools.

## Installation Steps

1. **Install the CPU-only version of TensorFlow.js** (no native bindings required):
```bash
npm install @tensorflow/tfjs --legacy-peer-deps
```

2. **Install face-api.js**:
```bash
npm install @vladmandic/face-api --legacy-peer-deps
```

3. **Install all at once**:
```bash
npm install @tensorflow/tfjs @vladmandic/face-api --legacy-peer-deps
```

## Why CPU-only?

- `@tensorflow/tfjs` (CPU-only): Pure JavaScript, no native bindings, works everywhere
- `@tensorflow/tfjs-node`: Requires Visual Studio build tools on Windows

The CPU-only version is slightly slower but much easier to install and works cross-platform without any native dependencies.

## Performance

- CPU-only: ~500-1000ms per image (acceptable for server use)
- Native bindings: ~200-500ms per image (requires Visual Studio on Windows)

## Alternative: If you want native bindings (faster)

You would need to:
1. Install Visual Studio 2019/2022 with "Desktop development with C++" workload
2. Install Windows Build Tools: `npm install --global windows-build-tools`
3. Then use `@tensorflow/tfjs-node` instead

For most use cases, the CPU-only version is sufficient.






