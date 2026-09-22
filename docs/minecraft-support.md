# Minecraft support boundaries

Orbitra keeps Minecraft data separate from the ROM library. The browser reads Mojang's public Java Edition catalog, resolves the selected version's official dependency graph, verifies every declared size and SHA-1, and stores verified files in a dedicated IndexedDB database (`orbitra-minecraft`). Version records refer to content-addressed blobs, so identical assets and libraries are saved once and remain available while any installed version references them.

## Official network sources

Only HTTPS requests to these hosts are accepted:

- `piston-meta.mojang.com`
- `launchermeta.mojang.com`
- `piston-data.mojang.com`
- `launcher.mojang.com`
- `libraries.minecraft.net`
- `resources.download.minecraft.net`

Some official library and asset responses do not include browser CORS headers. Orbitra therefore exposes the same-origin `/minecraft-official/<host>/<path>` transport in the Vite development server, the Node runtime, and the Docker Nginx image. The transport has a fixed host allowlist, accepts only `GET` and `HEAD`, drops cookies and authorization headers, rejects redirects outside the allowlist, and never changes the expected digest. The browser verifies the original metadata's size and SHA-1 after receiving each response.

The catalog uses `ETag` / `Last-Modified` conditional requests when the official service supplies them. A failed refresh can display the last cache with its original fetch time, but is never reported as a successful refresh.

## Local storage and recovery

- Version metadata, client JARs, libraries, native libraries, logging configuration, asset indexes, and asset objects are stored as verified blobs in IndexedDB.
- A version becomes installed only after every required file is present. Interrupted work is recorded separately and can reuse already verified files on the next attempt.
- Delete removes only blobs no longer referenced by another installed version.
- Verify and repair hashes local blobs again and fetches only missing or damaged files.
- Minecraft files are not included in ROM ZIP import, ROM backup, account sync, or the public online game library.

Large modern versions can require hundreds of megabytes. The browser's actual site quota remains authoritative; a quota failure leaves the version uncommitted. Individual files are currently buffered for SHA-1 verification before IndexedDB storage. Downloads resume between complete files, not within a partial file.

## Browser runtime

The only browser-playable target currently exposed is unmodified **Minecraft Java Edition 1.2.5**. It uses the Browsercraft bridge with its LWJGL 2.9.3 and GL4ES dependencies, plus the externally hosted CheerpJ 4.3 Java 8 runtime, inside a disposable same-origin iframe. Closing the player or reaching the three-minute demonstration limit destroys the iframe and its JVM state. Exact sources, checksums, and license texts for the bundled bridge files are recorded in `public/lwjgl/NOTICE.md`.

The user must accept the Minecraft EULA before the client JAR is passed to the runtime. Orbitra does not bundle the client, collect Microsoft credentials, create offline accounts, or claim ownership authorization. CheerpJ Community Edition is limited to personal and non-business use and needs its network runtime; self-hosting requires a separate CheerpJ license.

Modern Minecraft versions use Java and LWJGL generations that do not have a verified Orbitra browser bridge. They can be downloaded, verified, repaired, and retained offline, but are not shown as playable. Bedrock Edition remains limited to its official store link because there is no equivalent public historical-version catalog.
