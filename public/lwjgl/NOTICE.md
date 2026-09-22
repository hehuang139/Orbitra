# Browsercraft LWJGL browser bridge

These files are copied unchanged from [Leaning Technologies Browsercraft](https://github.com/leaningtech/browsercraft) at commit [`001849b7b8079706df29144f74327a84a5efd50f`](https://github.com/leaningtech/browsercraft/tree/001849b7b8079706df29144f74327a84a5efd50f). Browsercraft is Apache-2.0 licensed, while the upstream components included in its binary bundle retain their own licenses:

- `lwjgl-2.9.3.jar` and `lwjgl_util-2.9.3.jar`: LWJGL 2.9.3, BSD 3-Clause-style license ([license text](LICENSE-LWJGL-2.txt)).
- `libraries/gl4es.wasm`: GL4ES, MIT license ([license text](LICENSE-GL4ES.txt)).
- `libraries/liblwjgl.so` and `libraries/lwjgl.js`: Browsercraft's CheerpJ/LWJGL bridge, Apache-2.0 ([license text](LICENSE-APACHE-2.0.txt)).

The files are used unchanged by the optional Minecraft Java Edition 1.2.5 browser demonstration. Their SHA-256 digests are:

| File                    | SHA-256                                                            |
| ----------------------- | ------------------------------------------------------------------ |
| `lwjgl-2.9.3.jar`       | `527d509f60132e5b2653c7fc0f8cf299d6f698f4a8013342bef47705dc57ed3f` |
| `lwjgl_util-2.9.3.jar`  | `6f4a261384e1688a3359420efce5275c8693b822a8c6eaa1e20d5cc126a51571` |
| `libraries/gl4es.wasm`  | `d8a9908599b9f78a5c4818e94b1632f17d76d176b9b43939b8c95c30e6083d06` |
| `libraries/liblwjgl.so` | `5e2b15a7ce7aef72001996cd5d184004cb79af48326d8593cb166baa38640376` |
| `libraries/lwjgl.js`    | `12b85633f2d78cbf4ce017f15e4095a4dc9f38e76b1bfedfc72178bc6f6cab13` |

Minecraft client JARs and assets are never bundled here. They are fetched from and verified against Mojang's official version metadata at runtime.
