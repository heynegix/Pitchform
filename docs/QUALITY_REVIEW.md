# Pitchform quality review

This review records the current risks from independent perspectives. It is intentionally
critical: passing automated checks does not prove perceptual quality, real-device behavior,
or production readiness.

## Findings and actions

| Perspective | Critical finding | Action in this review | Remaining evidence gap |
| --- | --- | --- | --- |
| Audio analysis and DSP | Fixed-frame processing can be expensive on long material, and boundary behavior is easy to misread as pitch. | Reduced unnecessary sample copies and duplicate per-frame work; kept the existing deterministic renderer and tests. | Listening tests with quiet, noisy, reverberant, and double-tracked vocals are still required. |
| Editing UX | Canvas-only seeking and pitch entry make precision work difficult without a pointer. | Added an accessible playhead slider and quarter-tone numeric MIDI input; kept direct manipulation intact. | Human usability testing has not been run. |
| State and recovery | Unbounded undo snapshots can grow with note count and eventually compete with audio memory. | Capped undo/redo history at 100 snapshots and added bounded project collections. | A memory profile on long files is still needed. |
| Accessibility | A visual piano roll does not expose enough operation guidance to keyboard and assistive-technology users. | Added focus behavior, keyboard help, live status semantics, pressed states, and reduced-motion handling. | Screen-reader testing on Windows/macOS and browser combinations is still pending. |
| Security and hostile input | Valid types alone are insufficient for a project that can contain huge, overlapping, or internally inconsistent collections. | Reject non-monotonic frames, overlapping notes, stale cents metadata, out-of-range MIDI, oversized collections, and out-of-range viewport/duration values before opening. | Fuzzing and malformed-file corpus testing are not yet in CI. |
| Performance and rendering | Repainting every note on every playhead tick can become expensive for pathological projects. | Lowered accepted project note count to a bounded editor-safe limit and limited plotted pitch frames. | A layered static/dynamic Canvas renderer remains a future optimization. |

## Explicitly not claimed

- No claim is made that Pitchform is production-ready.
- No claim is made that the renderer preserves formants or handles polyphonic material.
- No real-device, third-party, or listening-study result is implied by this review.

## Priority order after this review

1. Run structured listening tests on representative monophonic recordings.
2. Add a malformed-project corpus and fuzz the project validator.
3. Add browser/Tauri accessibility checks and real-device validation.
4. Revisit layered rendering only after measurements show Canvas redraw is a real bottleneck.
