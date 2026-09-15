# Architecture decisions

## 2026-09-15 — Start with a browser-capable core inside a Tauri shell

Pitchform uses React + TypeScript for the first vertical slice and Tauri 2 for desktop packaging. The core audio model is framework-independent. This gives the project an immediately testable UI while preserving a path to native Rust DSP when quality or performance requires it.

## 2026-09-15 — Use deterministic DSP first; defer model redistribution

The initial detector is a small YIN-style implementation and the initial correction renderer is a replaceable resampling backend. RMVPE, FCPE, CREPE, Basic Pitch, and ONNX model packages are not embedded yet because model weights and runtime redistribution terms must be audited separately from source-code licenses.

## 2026-09-15 — Do not link GPL DSP code in the MVP

Rubber Band and other mature pitch/time libraries remain candidates, but their license and commercial redistribution obligations need a dedicated decision. The first implementation avoids a licensing lock-in and exposes correction through a narrow internal function.

## 2026-09-15 — Embed a WAV asset in `.pitchform`

The first project format embeds a PCM WAV asset alongside source metadata, analysis, edits, and editor state. This makes Save → Open work offline and avoids a fragile absolute path. The format is versioned so future projects can move to external assets without silently breaking old files.

