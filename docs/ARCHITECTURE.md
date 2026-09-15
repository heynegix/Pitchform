# Pitchform architecture

## Boundary

```text
React UI
  ├─ editor state and interactions
  ├─ canvas rendering
  └─ file input/download adapters
        ↓ typed modules
Audio and project core
  ├─ WAV encode/decode helpers
  ├─ monophonic F0 analysis
  ├─ note segmentation
  ├─ correction renderer
  └─ .pitchform serialization
        ↓
Tauri 2 shell (desktop packaging only)
```

The analysis and rendering modules do not import React or Tauri. This keeps the core testable in Node and leaves room for a Rust implementation or a Web Worker without changing the editor model.

## Current processing path

1. The browser/webview decodes WAV, MP3, or FLAC into an `AudioBuffer`.
2. The first channel is downmixed and analyzed in a worker-friendly pure function. The current UI runs it asynchronously through a worker when supported and falls back to the main thread for constrained environments.
3. YIN-style difference analysis produces voiced F0 frames, confidence, and MIDI pitch.
4. Rule-based segmentation groups stable voiced frames into editable `Note` objects.
5. The editor changes only `targetPitchMidi`; original analysis remains immutable.
6. Preview/export uses a deterministic per-note resampling renderer. It preserves the project timeline and is deliberately replaceable by a higher-quality phase-vocoder or neural backend later.

## Invariants

- source audio is never mutated;
- analysis pitch and user target pitch are separate fields;
- note times are seconds and always satisfy `0 <= start < end <= duration`;
- serialization is versioned;
- all audio samples written to WAV are finite and clipped to `[-1, 1]`.

