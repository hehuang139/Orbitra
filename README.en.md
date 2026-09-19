<div align="center">

<img src="public/favicon.svg" width="72" height="72" alt="Advance logo" />

# Advance

**Your space for handheld games.**

A modern GBA, GB, GBC, FC / NES and SFC / SNES emulator for the browser, powered by local WebAssembly cores.

[![Application license: MIT](https://img.shields.io/badge/Application-MIT-a8f0c4?style=flat-square&labelColor=173227)](LICENSE)
[![Core: mGBA WASM](https://img.shields.io/badge/Core-mGBA_WASM-a8f0c4?style=flat-square&labelColor=173227)](public/emulator/NOTICE.md)
[![React 19](https://img.shields.io/badge/React-19-61dafb?style=flat-square&labelColor=173227)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-3178c6?style=flat-square&labelColor=173227)](https://www.typescriptlang.org/)

[简体中文](README.md) · [Features](#features) · [Quick start](#quick-start) · [Deployment](#deployment) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md)

</div>

![Advance desktop game library](docs/images/desktop-library.png)

Advance combines a dark, mint-accented interface with a local game library, save states and keyboard, gamepad and touch controls. The interface is currently in Chinese and adapts to desktop, tablet and phone screens. Bundled mGBA, FCEUmm and Snes9x cores run the supported systems locally.

No account or user-supplied BIOS is required. Try **Star Orbit**, an original, MIT-licensed homebrew game included in the repository. No commercial game ROMs are distributed with this project.

## Screenshots

All screenshots show the real application. Game footage comes from the included original homebrew ROM. Alongside the library overview above, the gallery covers saves, controls, settings, help and mobile play.

### 1. Save manager and save states

The save manager collects automatic and manual states across games, with screenshot previews, timestamps and actions to resume, export or delete a state.

![Save manager with automatic and manual states, screenshot previews, resume and export actions](docs/images/save-manager.png)

The in-game save panel provides **one automatic slot and five manual slots**. Save, load, import and export states, or back up and import a game's battery save (`.sav`).

<p align="center">
  <a href="docs/images/save-states.png"><img src="docs/images/save-states.png" width="760" alt="Save state panel with automatic and manual slots, import and export controls" /></a>
</p>

### 2. Controller and emulator settings

|                                                          Controller settings                                                           |                                                       Emulator settings                                                       |
| :------------------------------------------------------------------------------------------------------------------------------------: | :---------------------------------------------------------------------------------------------------------------------------: |
| ![Controller settings with keyboard mappings, standard gamepad guidance and touch control toggle](docs/images/controller-settings.png) | ![Emulator settings with display style, speed, volume, automatic saves and touch controls](docs/images/emulator-settings.png) |
|         Configure keyboard and gamepad mappings, stick deadzone, touch layout, size and opacity; restore defaults when needed.         |          Choose display style, 1× / 2× / 4× speed, volume and automatic saves. Preferences are saved automatically.           |

### 3. Help and keyboard shortcuts

The built-in guide explains supported ROM and ZIP imports, keyboard controls and saves, with a quick reference for pause, quick save/load, fast-forward, rewind and fullscreen.

<p align="center">
  <a href="docs/images/help-shortcuts.png"><img src="docs/images/help-shortcuts.png" width="760" alt="Help guide with import instructions, controls, save guidance and keyboard shortcuts" /></a>
</p>

### 4. Gameplay and display styles

|                                          Native pixels                                           |                                       Retro CRT                                       |
| :----------------------------------------------------------------------------------------------: | :-----------------------------------------------------------------------------------: |
| ![Desktop player running Star Orbit with native pixel rendering](docs/images/desktop-player.png) | ![Star Orbit running with the retro CRT scanline filter](docs/images/display-crt.png) |
|    Playback, quick save/load, speed, screenshot and fullscreen controls sit below the screen.    |    Switch to CRT scanlines in settings, or choose native pixels or smooth scaling.    |

### 5. Favorites and library list

Keep favorite games together. List view shows game details and play history, with search, sorting and launch controls available.

![Favorites in list view with game details, play history, search, sorting and launch controls](docs/images/favorites.png)

### 6. Mobile touch controls

The mobile layout exposes platform-specific controls, including X / Y / L / R for SFC games, alongside an accessible playback toolbar. Choose standard or compact layouts and adjust button size and opacity. Multiple fingers can hold buttons simultaneously; changing orientation releases held inputs.

<p align="center">
  <a href="docs/images/mobile-player.png"><img src="docs/images/mobile-player.png" width="320" alt="Advance mobile player with playback toolbar and on-screen gamepad" /></a>
</p>

## Features

- **Portable backups:** choose games and optionally include ROMs in a versioned ZIP with SHA-256 checksums. Preview before restoring, match missing ROMs by content, select individual conflicts, and roll back the entire restore on failure. Existing progress is kept by default; unknown or different-core states are unchecked.
- **Real emulation:** bundled mGBA, FCEUmm and Snes9x WASM cores support GBA, GB, GBC, FC / NES and SFC / SNES.
- **Local library:** multiple-file and drag-and-drop imports, platform labels and filters, search, sorting, favorites, recent play, playtime, grid and list views.
- **ZIP support:** import supported ROMs from nested folders, with platform-scoped SHA-256 deduplication that preserves progress without sharing saves across platforms.
- **Save states:** five manual slots and one automatic slot, screenshot previews, quick save/load and import/export.
- **Progress management:** automatic states every 30 seconds and when returning to the library or hiding the page, when enabled; `.sav` import/export.
- **Playback:** pause, resume, reset, fullscreen, 1× / 2× / 4× speed, hold-to-fast-forward, hold-to-rewind, volume and mute.
- **Controls:** remappable keyboard; device-specific gamepad button / axis mappings and deadzone; standard / compact touch layouts with adjustable size and opacity.
- **Display:** platform-native aspect ratios, WebGL 2 with an automatic Canvas 2D software fallback, pixel, smooth and CRT scanline filters, and real-core screenshots.
- **Local data and account sync:** IndexedDB stores ROMs, library metadata and saves; localStorage stores preferences. Optional self-hosted accounts sync ROMs and saves so a fresh browser can restore them. Runtime assets are bundled without an external CDN dependency.
- **Homebrew demo:** reproducible ARM code with double-buffered graphics, native input, PSG audio and SRAM saves.

## Quick start

Recommended: **Node.js 24** and **pnpm 11.19.0**. Minimum Node.js version: 22.18. If pnpm is not installed, run `npm install --global pnpm@11.19.0` first.

```sh
git clone https://github.com/hehuang139/gba-emu.git
cd gba-emu
pnpm install --frozen-lockfile
pnpm dev
```

Open [http://localhost:5173](http://localhost:5173). Click **「开始试玩」** to start the demo, or import your own `.gba`, `.gb`, `.gbc`, `.nes`, `.sfc`, `.smc` or `.zip` file.

In Star Orbit, move toward the gold beacons to collect points. Hold `X` to boost, press `Z` to emit a pulse, and press `Enter` to reset. See the [demo documentation](public/demo/README.md) for its source and build instructions.

## Controls

Launching a game focuses its screen; clicking the screen restores that focus. Gameplay keys and shortcuts apply only while the screen is focused. Use `Esc` or `Shift + Tab` to leave it, then navigate the interface with normal `Tab`, `Enter` and `Space` behavior. Closing a dialog restores its trigger's focus, and exiting a game restores the launch control. Change emulated-button mappings in controller settings and press `Esc` to cancel capture. Emulator shortcuts remain reserved.

| Action                    | Default key             |
| ------------------------- | ----------------------- |
| D-pad                     | Arrow keys              |
| A / B                     | `X` / `Z`               |
| X / Y (SFC only)          | `C` / `V`               |
| L / R (GBA and SFC)       | `A` / `S`               |
| Start / Select            | `Enter` / Right `Shift` |
| Pause / resume            | `Space`                 |
| Save / load manual slot 1 | `F5` / `F8`             |
| Temporary 2× speed        | Hold `Tab`              |
| Rewind                    | Hold `Backspace`        |
| Fullscreen                | `F11`                   |

Standard gamepads retain default face / shoulder / menu buttons, D-pad and left-stick mappings; the UI hides buttons that the active platform does not use. Press a gamepad button once to make it visible to the browser. In controller settings, select the device, choose an emulated button, then press a physical button or move an axis. Capture can be cancelled, individual mappings cleared and defaults restored. Stick deadzone ranges from 10% to 90%. Nonstandard devices start with no guessed mappings. Profiles persist by browser-provided device identity and layout, independent of connection slot; devices with the same identity and layout share a profile.

Touch settings offer standard / compact layouts, 80%–130% button size and 40%–100% opacity. Settings persist across reloads and older preferences receive safe defaults. Narrow screens constrain actual button size, and styles reserve safe-area spacing. Disconnection, blur, dialogs, pointer cancellation and pause release the relevant input. A key held by several input sources remains pressed until every source releases it. Physical phone, controller and assistive-technology coverage is documented in the [compatibility record](docs/compatibility-matrix.md).

## Import and save limits

Single `.gba` files must be between 192 bytes and 32 MiB; `.gb` and `.gbc` files between 32 KiB and 8 MiB; `.nes` files between 16 KiB + 16 bytes and 8 MiB with an iNES header; and `.sfc` / `.smc` files between 32 KiB and 16 MiB. ZIP files may be up to 64 MiB, contain up to 32 games and expand to at most 128 MiB of ROM data. Stored and Deflate compression are supported; encrypted, ZIP64, split and nested ZIP archives are not. Imports verify platform-specific sizes and CRC values and ignore documentation and macOS metadata.

Battery saves (`.sav`) contain a game's own saved progress. Save states capture the full emulation state and require the matching game, platform and compatible core version. Clearing site data, ending an incognito session or browser storage eviction can delete unsynced local files. Sign in or export important saves so they can be restored in a new browser. Force-closing the browser can lose progress since the last automatic save or sync.

The adapter waits for the current game's first completed frame before allowing save operations. Battery export reads live cartridge save data from a native state snapshot, avoiding stale SRAM when the core has not yet flushed its virtual filesystem. This change does not upgrade the bundled mGBA core or change public `.sav` / save-state formats.

## Deployment

```sh
pnpm build
pnpm start
```

The output is in `dist/`; the production server runs at [http://localhost:4173](http://localhost:4173) by default. `pnpm start` serves the app and same-origin account API, storing accounts, sessions and each user's latest library snapshot in `.data/advance.sqlite`. Configure `HOST`, `PORT` and `ADVANCE_DATA_DIR` as needed, keep the data directory writable, and back up the SQLite database.

The production server can serve HTTPS directly when both `TLS_CERT_PATH` and `TLS_KEY_PATH` point to PEM certificate and private-key files. A LAN IP certificate must contain that IP as a Subject Alternative Name and be trusted by each client device; plain HTTP cannot provide the secure context required by Web Crypto and SharedArrayBuffer.

`pnpm dev` and `pnpm preview` also enable the account API for development. Static-only hosting keeps IndexedDB persistence but cannot provide sign-in or cross-browser restore. Account snapshots are capped at 72 MiB and contain imported ROMs and saves; deploy behind HTTPS. Server-side snapshots are not end-to-end encrypted.

**The threaded WASM core requires HTTPS or localhost and cross-origin isolation.** Serve these response headers:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Vite development and preview servers already set them. The included `public/_headers` supports compatible Netlify / Cloudflare Pages deployments. Other hosts must configure the headers explicitly. Serve the core and application from the same origin; the current build assumes a site-root deployment.

Plain HTTP on a LAN address and hosts without the required headers will not run the core. Default GitHub Pages hosting does not support these custom response headers and is not a direct deployment target for this version. Browsers need SharedArrayBuffer, WebAssembly threads, Canvas 2D and IndexedDB. The application prefers WebGL 2 and automatically uses a slower Canvas 2D software renderer when WebGL 2 cannot be created. The production build includes a versioned PWA shell and user-controlled offline cache updates; real mobile installation still needs validation.

## Development and testing

```sh
pnpm test
pnpm test:account-server
pnpm build
pnpm exec playwright install chromium

# Keep pnpm dev running in another terminal
pnpm test:engine
pnpm test:platforms
pnpm test:ui
pnpm test:zip
pnpm test:saves
pnpm test:keyboard
pnpm test:gamepad
pnpm test:touch
pnpm test:startup
pnpm test:backup
```

Unit tests cover storage, ZIP imports, environment checks, input ownership, preference migration, gamepad / touch configuration and native battery snapshot boundaries and decompression. Browser suites cover real GBA / GB / GBC / FC / SFC core execution, native display ratios, platform filtering, state restoration, rewind, live SRAM, worker cleanup, library / save / backup flows, keyboard focus and navigation, synthetic gamepads, touch pointers and narrow / landscape viewports. Startup regression covers failed prerequisites, storage failures, first-frame readiness, timeout and disposal during loading.

Browser tests default to `http://127.0.0.1:5173`; use `ENGINE_TEST_URL` or `UI_TEST_URL` to override it. The engine, gamepad and startup suites require Vite development pages or module instrumentation. `BROWSER_EXECUTABLE_PATH` can select an installed Chromium / Chrome / Edge binary. Synthetic Gamepad API input and mobile viewports do not certify physical controllers, phones, audio quality or screen-reader usability. The generated GB / GBC fixtures cover MBC1 with 8 KiB battery RAM; other mappers, RTC behavior and broad commercial-ROM compatibility remain unverified.

The [contributing guide](CONTRIBUTING.md) describes the project structure and test workflow in more detail. English Issues and PRs are welcome.

## Roadmap and compatibility

Gamepad and touch customization and keyboard focus improvements are implemented. Remaining work includes physical-device and screen-reader verification, broader browser / low-end-device evidence, UI localization and more redistributable homebrew tests. Backup and restore software is implemented; its remaining device and memory validation is tracked in the [v1.2 roadmap](docs/roadmaps/v1.2.md). See the [full roadmap](ROADMAP.md) for scope and acceptance goals and the [changelog](CHANGELOG.md) for release history. The v1.1 validation work remains open where devices or manual evidence are missing; unchecked items are not release-date commitments.

FC / NES and SFC / SNES currently provide single-player baseline support. Two-player input, comprehensive mapper / enhancement-chip coverage, link play and cheats are not supported. Self-hosted account snapshot sync is available; concurrent multi-device editing and hosted third-party sync are not. The project has not been tested against a comprehensive commercial ROM library; individual game compatibility still needs verification.

## Acknowledgments and license

Thanks to [mGBA](https://mgba.io/), the [mgba-wasm port](https://github.com/thenick775/mgba), [EmulatorJS](https://github.com/EmulatorJS/EmulatorJS), FCEUmm and Snes9x contributors for making the emulator possible. The interface and tooling also use [React](https://react.dev/), [TypeScript](https://www.typescriptlang.org/), [Vite](https://vite.dev/), [Lucide](https://lucide.dev/), [fflate](https://github.com/101arrowz/fflate), [DM Sans](https://github.com/googlefonts/dm-fonts), [Playwright](https://playwright.dev/) and [fake-indexeddb](https://github.com/dumbmatter/fakeIndexedDB).

Application code and original demo content are licensed under [MIT](LICENSE). **Third-party components retain their own licenses:** mGBA / mgba-wasm use MPL-2.0; EmulatorJS, FCEUmm and Snes9x use the licenses bundled with their local runtime; DM Sans uses SIL OFL 1.1. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md), [mGBA provenance](public/emulator/NOTICE.md) and [EmulatorJS provenance](public/emulatorjs/NOTICE.md) before redistributing.

Game Boy, Game Boy Color and Game Boy Advance are trademarks of Nintendo. This independent project is not affiliated with or endorsed by Nintendo.
