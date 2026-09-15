# Pitchform

**Edit vocals like notes. Free and open source.**

Pitchform is a local-first visual vocal editor for intuitive, note-based pitch correction. Drop in a mono vocal, see its pitch as notes, drag a note up or down, preview the result, and export a WAV.

```text
Drop audio → Edit notes → Export
```

## Current status

Pitchform is an early `0.1.0` MVP foundation. The current app already includes:

- WAV/MP3/FLAC import through the desktop webview's native decoder
- waveform and piano-roll visualization
- canvas click-to-seek and Alt-drag loop selection
- local monophonic F0 detection with confidence values
- rule-based note segmentation
- vertical note dragging with semitone snapping and fine adjustment
- undo/redo, original/corrected A/B preview, and WAV export
- duration-preserving phase-vocoder preview for sustained note corrections
- self-contained `.pitchform` JSON project files
- no account, cloud upload, telemetry, or required API key

Pitch detection and the lightweight correction renderer are intentionally designed for **single-voice, monophonic material**. Polyphonic editing, realtime autotune, plugins, and cloud features are out of scope for v0.1.

## Run locally

```bash
npm install
npm run dev
```

The web UI can be exercised in a browser. For the desktop shell:

```bash
npm run tauri dev
```

Quality checks:

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Privacy

Audio is processed in the local app. Pitchform does not upload audio, require an account, or include analytics. See [SECURITY.md](SECURITY.md).

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Roadmap](docs/ROADMAP.md)
- [Decisions](docs/DECISIONS.md)
- [Dependencies and licenses](docs/DEPENDENCIES.md)
- [Contributing](CONTRIBUTING.md)

## License

Pitchform is released under the MIT License. See [LICENSE](LICENSE).
