# Architecture decisions

## 2026-09-15 — Start with a browser-capable core inside a Tauri shell

Pitchform uses React + TypeScript for the first vertical slice and Tauri 2 for desktop packaging. The core audio model is framework-independent. This gives the project an immediately testable UI while preserving a path to native Rust DSP when quality or performance requires it.

## 2026-09-15 — Use deterministic DSP first; defer model redistribution

The initial detector is a small YIN-style implementation and the initial correction renderer is a replaceable resampling backend. RMVPE, FCPE, CREPE, Basic Pitch, and ONNX model packages are not embedded yet because model weights and runtime redistribution terms must be audited separately from source-code licenses.

## 2026-09-15 — Do not link GPL DSP code in the MVP

Rubber Band and other mature pitch/time libraries remain candidates, but their license and commercial redistribution obligations need a dedicated decision. The first implementation avoids a licensing lock-in and exposes correction through a narrow internal function.

## 2026-09-15 — Embed a WAV asset in `.pitchform`

The first project format embeds a PCM WAV asset alongside source metadata, analysis, edits, and editor state. This makes Save → Open work offline and avoids a fragile absolute path. The format is versioned so future projects can move to external assets without silently breaking old files.

## 2026-09-15 — Cancel stale asynchronous work

Opening or dropping a second file must never allow the first file's analysis or render to overwrite the current document. Loads and worker jobs therefore carry an operation identity and abort stale analysis/render tasks. Rendering is debounced briefly during drag edits so pointer movement does not create an unbounded worker queue.

## 2026-09-15 — Bound project input before parsing

`.pitchform` is JSON with embedded base64 audio, so an untrusted file can otherwise cause excessive allocation before validation. The app rejects project files above 256 MB, validates the envelope and note/frame limits, and verifies that decoded audio matches the stored analysis duration before changing editor state. The sample rate is allowed to differ because browser `AudioContext` implementations may resample decoded audio; the current buffer's actual rate is used for rendering and future saves.

## 2026-09-15 — Bound audio imports before decoding

Audio decoding can allocate substantially more memory than the compressed file size. The browser path therefore rejects source audio larger than 256 MB before creating an `AudioContext`. This keeps an accidental or malicious large drop from causing an avoidable memory spike; longer or higher-quality source support can be revisited with measured streaming limits.

## 2026-09-15 — Bound decoded audio and expose progress

Compressed input size alone does not bound decoded memory, and embedded project audio follows a separate open path. Both paths now validate decoded duration and total channel samples immediately after `decodeAudioData`. Analysis also emits throttled progress through the worker so long local operations have visible feedback without flooding the UI event loop.

## 2026-09-15 — Make the editor keyboard-complete

The canvas is focusable and the application supports keyboard transport, note navigation, semitone/quarter-tone nudging, reset, undo/redo, and project save. These actions use the same pitch quantization and history model as pointer editing. Dirty-state protection covers persisted editor settings as well as note targets, preventing a loop or zoom change from being silently lost.

## 2026-09-15 — Keep the piano-key gutter outside the timeline

The editor reserves a fixed left gutter for piano keys. Timeline coordinates begin after that gutter and use the same mapping for notes, pitch curves, waveforms, playhead, seeking, and loop selection. This prevents a visible click position from seeking to a different time than the content under the cursor.

## 2026-09-15 — Check in generated desktop bundle icons

Tauri's Windows resource build and future macOS/Windows bundling require platform-specific icon files. The checked-in assets are generated from the project icon with the Tauri CLI and are explicitly listed in `tauri.conf.json`, so a clean runner can build the desktop bundle without relying on a developer's local generated files.

## 2026-09-15 — Use a dependency-free phase-vocoder preview backend

The first renderer's per-note sample re-indexing changed pitch by effectively speeding up or slowing down each note and could hold the final sample at note boundaries. A small FFT phase-vocoder path now preserves note duration for sustained material, with edge crossfades and a bounded fallback for short or very large notes. This improves the current local preview without introducing an unreviewed DSP dependency or its license obligations; formant preservation and real-world vocal evaluation remain follow-up work.

## 2026-09-15 — Add bounded context around each corrected note

Evaluation with a real 44.1 kHz mono vocal mix showed that note-by-note processing must see the transient and phase material immediately before and after a note. The renderer now supplies up to 20 ms (capped at 4,096 samples) of source context to the phase vocoder, but mixes the result back only within the note's original sample range and retains the existing crossfade. This reduces edge-start artifacts without changing neighboring audio or making context memory unbounded. Perceptual quality still requires listening-based evaluation, especially for double-tracked or otherwise non-monophonic material.
