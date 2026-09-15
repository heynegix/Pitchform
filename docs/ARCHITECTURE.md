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
2. The first channel is downmixed and analyzed in a worker-friendly pure function. The UI runs analysis asynchronously through a dedicated worker when supported and cancels stale work when a newer file is opened.
3. YIN-style difference analysis produces voiced F0 frames, confidence, and MIDI pitch.
4. Rule-based segmentation groups stable voiced frames into editable `Note` objects.
5. The editor changes only `targetPitchMidi`; original analysis remains immutable.
6. Canvas clicks seek the transport, while Alt-drag creates an explicit loop range. A loop selection is editor state, not an audio edit, and is restored when a project is reopened.
7. Preview/export uses a deterministic per-note resampling renderer in a dedicated worker. It preserves the project timeline and is deliberately replaceable by a higher-quality phase-vocoder or neural backend later.

## Invariants

- source audio is never mutated;
- analysis pitch and user target pitch are separate fields;
- note times are seconds and always satisfy `0 <= start < end <= duration`;
- serialization is versioned;
- all audio samples written to WAV are finite and clipped to `[-1, 1]`.
- project files are size- and shape-validated before their embedded audio is decoded;
- embedded project audio is capped at 256 MB of project JSON and must match the stored duration; the decoded sample rate may vary because browsers can resample through `AudioContext`;
- loop ranges are optional, finite, strictly positive, and bounded by the analyzed duration; older projects without loop fields remain valid;
- imported audio files are capped at 256 MB before decoding, and a new document resets transport/editor viewport state rather than inheriting the previous document's position;
- timeline coordinates exclude the fixed piano-key gutter, so drawing, seeking, waveform peaks, notes, and loop ranges share one time origin;
- undo/redo stacks are mutated outside React state updater callbacks and a small render signal keeps toolbar availability synchronized without Strict Mode side effects;
- CI runs frontend checks plus Rust/Tauri checks on Ubuntu, Windows, and macOS, with dependency auditing and bounded job duration;
- only the newest load/render operation may update application state.
