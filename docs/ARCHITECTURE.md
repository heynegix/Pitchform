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
2. The decoded buffer is checked for finite duration and bounded channel-sample memory before the first channel is downmixed. The mono signal is analyzed in a worker-friendly pure function. The UI runs analysis asynchronously through a dedicated worker when supported, receives throttled progress updates, and cancels stale work when a newer file is opened.
3. YIN-style difference analysis produces voiced F0 frames, confidence, and MIDI pitch.
4. Rule-based segmentation groups stable voiced frames into editable `Note` objects.
5. The editor changes only `targetPitchMidi`; original analysis remains immutable.
6. Canvas clicks seek the transport, while Alt-drag creates an explicit loop range. A loop selection is editor state, not an audio edit, and is restored when a project is reopened.
7. Preview/export uses a deterministic per-note pitch-shift renderer in a dedicated worker. Sustained notes use a dependency-free phase-vocoder path that preserves duration; each note is analyzed with bounded context on both sides and mixed back only inside its own time range with a short crossfade. Short or very large notes use a bounded linear fallback. The renderer boundary remains replaceable by a higher-quality or neural backend later.

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
- decoded audio is capped at 3,600 seconds and 192 million channel samples after decoding, protecting both direct imports and embedded project audio from compressed/decompressed size mismatches;
- project validation is additionally capped at 3,000,000 ordered pitch frames and 50,000 ordered, non-overlapping notes; note MIDI and cents metadata must agree;
- timeline coordinates exclude the fixed piano-key gutter, so drawing, seeking, waveform peaks, notes, and loop ranges share one time origin;
- undo/redo stacks are mutated outside React state updater callbacks, capped at 100 snapshots, and a small render signal keeps toolbar availability synchronized without Strict Mode side effects;
- CI runs frontend checks plus Rust/Tauri checks on Ubuntu, Windows, and macOS, with dependency auditing and bounded job duration;
- only the newest load/render operation may update application state.
- keyboard pitch edits, reset actions, and pointer edits share the same bounded MIDI quantization and undo history;
- the Canvas editor has a native playhead slider and numeric MIDI pitch fallback, with explicit focus help and reduced-motion behavior;
- project dirty state includes pitch edits, zoom, snap preference, and loop selection, and a dirty document warns before unload or replacement.
