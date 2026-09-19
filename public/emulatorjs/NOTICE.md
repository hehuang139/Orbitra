# EmulatorJS, FCEUmm and Snes9x WebAssembly runtime

This directory contains the self-hosted assets used for FC / NES and SFC / SNES emulation.
No game ROM or console firmware is included.

## Versions and sources

- EmulatorJS frontend 4.2.3, tag `v4.2.3` (`e150dc0491ae747028919fb82d6598954976ede6`):
  <https://github.com/EmulatorJS/EmulatorJS/tree/v4.2.3>
- FCEUmm core package `@emulatorjs/core-fceumm@4.2.3`, build report timestamp
  `2025-06-14T17:55:31Z`: <https://github.com/EmulatorJS/libretro-fceumm>
- Snes9x core package `@emulatorjs/core-snes9x@4.2.3`, build report timestamp
  `2025-06-14T17:58:11Z`: <https://github.com/EmulatorJS/snes9x>
- Core build system: <https://github.com/EmulatorJS/build>

The npm archives are fixed by the integrity values recorded by npm for version 4.2.3. The
application deliberately uses the non-threaded legacy WebAssembly variants so they can run on
WebGL 1 implementations as well as WebGL 2 implementations.

## Local frontend changes

The emulation core archives are redistributed unmodified. The readable EmulatorJS frontend source
is redistributed with four host integration changes, visibly marked with `Advance` comments:

1. Disable the runtime update request because all assets are pinned and served locally.
2. Keep `/data/saves` in memory when application-managed persistence is enabled.
3. Add `destroy()` and listener tracking so changing games in a single-page application releases
   window and DOM event handlers.
4. Expose rewind control and make application-owned teardown tolerate an in-memory save directory.

Modified source SHA-256 values:

- `src/emulator.js`: `3aa5fa9a93a7d4d8f7b430b9b576886adf79738fd8fcaf2e27e9a59cd86b7123`
- `src/GameManager.js`: `5445c09645d5d79068481b49f0f4594ab35705dafc82acdcc34cba7984e93635`

Unmodified core archive SHA-256 values:

- `cores/fceumm-legacy-wasm.data`: `f1054b094e7149fd6278485bc1b2e51ff75c5259048ddb1134171e53d651f239`
- `cores/snes9x-legacy-wasm.data`: `7d427a575cefad98ff400493fa1d7e892da63fe7bab68979babd9cea0bfaaf3b`

## Licenses

- EmulatorJS frontend: GNU GPL 3.0; see `LICENSE-GPL-3.0.txt`.
- FCEUmm: GNU GPL 2.0; see `LICENSE-FCEUMM-GPL-2.0.txt` and the source headers.
- Snes9x: the Snes9x license; see `LICENSE-SNES9X.txt`. Review its non-commercial-use terms
  before redistribution.

All names and trademarks belong to their respective owners. Compatibility names are used only to
identify the hardware formats implemented by the cores.
