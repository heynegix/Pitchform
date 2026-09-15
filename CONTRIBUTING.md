# Contributing to Pitchform

Pitchform values small, reviewable changes that make the import → detect → drag → play → export flow easier to understand.

## Development

1. Create a focused branch from `main`.
2. Install dependencies with `npm install`.
3. Make the smallest coherent change.
4. Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build`.
5. Open a pull request with the user-visible behavior and test evidence.

DSP or analysis changes should include deterministic synthetic tests. Keep browser/UI code separate from audio analysis and project serialization modules.

## Scope

The v0.1 target is intentionally narrow: monophonic audio, local processing, note editing, preview, WAV export, and project persistence. Please discuss large features such as plugin hosts, polyphonic editing, or online services before implementing them.

