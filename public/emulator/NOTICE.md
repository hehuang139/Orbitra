# mGBA WebAssembly runtime

This directory redistributes **@thenick775/mgba-wasm 2.5.1**, a WebAssembly
build of mGBA. The emulator itself is real mGBA; the application does not
implement or impersonate the emulated CPUs in JavaScript. This build includes
the mGBA Game Boy Advance, Game Boy, and Game Boy Color cores.

- mGBA: copyright Jeffrey Pfau and the mGBA contributors.
- WebAssembly port: Nicholas VanCise and contributors.
- License: Mozilla Public License 2.0; see `LICENSE-MPL-2.0.txt`.
- Corresponding source: https://github.com/thenick775/mgba/tree/e974b288bd7e5cfc7c7b96f8b4d32b673ddfb68c
- Upstream package: https://www.npmjs.com/package/@thenick775/mgba-wasm/v/2.5.1
- Upstream archive: https://registry.npmjs.org/@thenick775/mgba-wasm/-/mgba-wasm-2.5.1.tgz

`mgba.wasm` is distributed unmodified. `mgba.js` is the upstream JavaScript
source with the following local changes:

1. `hostIsGameReady()` exposes whether a pthread has started. The host waits
   for the emulation thread before accepting immediate save/state operations.
2. `hostDispose()` stops the game and main loop, unregisters runtime event
   listeners, terminates the worker pool, and closes its audio context.
3. SDL audio callbacks capture their owning audio instance as `activeAudio`
   and ignore events from a previous instance after a cartridge reload. Audio
   teardown also clears `onaudioprocess` before disconnecting its node. This
   prevents delayed Web Audio events from calling freed native audio memory.
4. `_fd_sync` calls `flushFile()` from the added `host-sync.js`: memory-only
   filesystems without `syncfs` return synchronously; asynchronous filesystem
   synchronization keeps its Promise path.
5. `__emscripten_receive_on_main_thread_js` calls `completeProxy()` from that
   helper to complete ordinary proxy results immediately and await Promise
   results only when needed. This avoids a MEMFS deadlock where the main
   thread waits for CPU pause while the CPU waits for a proxy-completion
   microtask that the blocked main thread cannot run.

The host methods are visibly marked in `mgba.js`; the audio guards can be
located by searching for `activeAudio`, and the synchronization entry points
by `flushFile` and `completeProxy`. These changes and the added `host-sync.js`
are licensed under MPL-2.0. The complete modified JavaScript source is
distributed as `mgba.js` and `host-sync.js`; the upstream repository and
archive above provide the remaining sources and build instructions. The
WebAssembly remains the unmodified 2.5.1 binary below; no core upgrade or
save-format migration is included. No proprietary game ROMs or Nintendo BIOS
are included.

Original WebAssembly SHA-256:
`c4c647d455840df684396b0a03833c1c2332793b73fabbba37d64323ad0c4c8d`

The runtime uses pthreads and must be served with:

```http
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Serve the JavaScript and WebAssembly files from the same origin as the app.
ROMs, battery saves, and save states are managed by the application's own
IndexedDB layer. The core's filesystem is deliberately kept in memory.
The application's adapter installs core callbacks synchronously after
`loadGame`, before the next animation frame starts the CPU thread. The
upstream callback-registration function is not synchronized with that thread;
registering callbacks after startup could race the CPU's callback vector.
