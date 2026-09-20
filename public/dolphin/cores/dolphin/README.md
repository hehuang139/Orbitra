# Dolphin Web Core Slot

> **License:** `dolphin-core-upstream.wasm` and `dolphin-core-upstream.js` in
> this directory are compiled from [Dolphin](https://github.com/dolphin-emu/dolphin)
> (© the Dolphin Emulator Project, GPLv2-or-later) and are therefore covered by
> the GPL. If you redistribute either file, you must also make its corresponding
> source available — see **License and attribution** in the top-level
> [README](../../README.md), and `npm run dist:source` to build the archive.

The local native core build writes a browser/Emscripten bundle in this directory:

```text
cores/dolphin/dolphin.js
cores/dolphin/dolphin.wasm
```

The host app automatically checks for `dolphin.js`. When present, `src/dolphin-adapter.js` loads it and mounts the selected disc through the Emscripten filesystem.

Expected factory shapes:

- ESM default export
- Named `createDolphinCore` export
- Global `window.createDolphinCore`
- Emscripten-style `window.Module`

Expected C exports for the first native ABI:

- `MountDisc(path)`
- `Reset()`
- `SetInputMask(mask)`
- `RunFrame()`
- `FrameWidth()`
- `FrameHeight()`
- `FrameBuffer()`
- `SaveState(slot)`
- `LoadState(slot)`
- `GetFrame()`
- `GetGameId()`
- `GetGameTitle()`
