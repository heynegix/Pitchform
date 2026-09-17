# Pitchform

**Edit vocals like notes. Free and open source.**

[![CI](https://github.com/heynegix/Pitchform/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/heynegix/Pitchform/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Pitchform is a free and open-source visual vocal editor for intuitive, note-based pitch correction.

```text
Drop audio → See notes → Move a note → Hear the result → Export WAV
```

## What it does

Pitchform analyzes a single-voice recording, turns detected pitches into editable note blobs, and lets you correct them directly on a piano-roll view.

- Import WAV, MP3, or FLAC audio
- See the waveform, pitch curve, piano-roll grid, note blobs, and playhead together
- Detect monophonic fundamental frequency (F0), voiced frames, and confidence values locally
- Drag notes vertically to change pitch
- Snap to semitones or make fine adjustments
- Preview original and corrected audio with A/B switching
- Select and loop a time range with Alt-drag
- Render sustained-note corrections with a duration-preserving phase-vocoder preview
- Keep the original source audio unchanged
- Export corrected audio as WAV
- Save and reopen self-contained `.pitchform` projects
- Use keyboard shortcuts for transport, navigation, pitch nudging, reset, undo/redo, and save

## Current status

Pitchform is an early `0.1.0` development build. The core local MVP workflow is implemented, but it is not a stable production release yet.

The current detector and editor are designed for **single-voice, monophonic material** such as an isolated vocal or instrument. Double-tracked, polyphonic, noisy, or heavily reverberated recordings can produce incorrect pitch or note boundaries.

The v0.1 renderer prioritizes deterministic local processing and duration stability. Formant preservation, advanced vibrato/drift editing, polyphonic editing, realtime correction, and plugin formats are not included.

Audio imports are limited to 256 MB compressed input, 60 minutes of decoded duration, and a bounded decoded sample budget. The effective duration limit can be lower for high sample-rate or multi-channel files.

## Controls

- Click a note to select it; drag vertically to change pitch.
- Hold `Shift` while dragging for quarter-tone adjustments.
- `Alt`-drag across the timeline to create a loop selection.
- `Space` plays or pauses; `←`/`→` selects neighboring notes.
- `↑`/`↓` nudges the selected note by a semitone; `Shift` nudges by a quarter tone.
- `R` resets the selected note to its detected pitch.
- The selected note's MIDI pitch can also be entered directly in the bottom panel.
- `Ctrl/Cmd+Z`, `Ctrl/Cmd+Shift+Z`, and `Ctrl/Cmd+S` undo, redo, and save.

Pitch edits and saved editor settings are marked as unsaved. Opening another audio file or project asks before discarding unsaved changes.

## Privacy first

- Audio is processed locally in the app.
- No account or cloud service is required.
- No audio upload is performed.
- No telemetry or analytics are included.
- The source recording is never overwritten by note edits or export.

## Run locally

Install dependencies and start the browser development UI:

```bash
npm install
npm run dev
```

To run the Tauri desktop shell:

```bash
npm run tauri dev
```

Run the project checks before submitting changes:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm audit --omit=dev --audit-level=high
```

## Architecture

The UI is built with React, TypeScript, and Vite inside a Tauri 2 desktop shell. Audio analysis, note segmentation, correction rendering, and project serialization are kept in framework-independent TypeScript modules and can run in Web Workers.

The current pipeline is:

```text
Audio file
  ↓
Local decode and mono downmix
  ↓
YIN-style F0 analysis
  ↓
Rule-based note segmentation
  ↓
Non-destructive note edits
  ↓
Worker-based preview rendering
  ↓
WAV export or .pitchform project
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for boundaries and invariants.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Dependency and license audit](docs/DEPENDENCIES.md)
- [Architecture decisions](docs/DECISIONS.md)
- [Quality review](docs/QUALITY_REVIEW.md)
- [Roadmap](docs/ROADMAP.md)
- [Contributing](CONTRIBUTING.md)
- [Security and privacy](SECURITY.md)

## License

Pitchform is released under the [MIT License](LICENSE).
