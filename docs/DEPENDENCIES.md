# Dependencies and licenses

This list records direct runtime/build dependencies used by the initial MVP. Versions are intentionally pinned by the lockfile when dependencies are installed.

| Dependency | Purpose | License | Redistribution | Source | Notes |
| --- | --- | --- | --- | --- | --- |
| React | UI | MIT | Allowed with notice | https://github.com/facebook/react | No audio processing |
| Vite | Frontend build | MIT | Allowed with notice | https://github.com/vitejs/vite | Build-time |
| TypeScript | Type checking | Apache-2.0 | Allowed with notice | https://github.com/microsoft/TypeScript | Build-time |
| Vitest | Tests | MIT | Allowed with notice | https://github.com/vitest-dev/vitest | Dev-only |
| Tauri 2 | Desktop shell | MIT / Apache-2.0 | Allowed with notices | https://github.com/tauri-apps/tauri | Native shell only |
| Rust standard ecosystem | Desktop build | Mixed permissive licenses | Audit through Cargo metadata | https://crates.io/ | Review before release packaging |

## Not currently bundled

Rubber Band, SoundTouch, Signalsmith Stretch, FFmpeg, ONNX Runtime, RMVPE, FCPE, CREPE, and Basic Pitch are research or future integration candidates, not current dependencies. They must be re-audited for source license, model-weight license, patent concerns, platform support, and redistribution obligations before inclusion.

