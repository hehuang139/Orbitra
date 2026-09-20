# Third-party notices / 第三方声明

Orbitra 自有应用代码、文档与界面采用 [MIT License](LICENSE)。此许可**不改变第三方组件的许可**；重新分发源码或构建产物时，请同时保留相应的版权与许可声明。

## 随仓库分发的资源

| 组件                       | 所在位置                                  | 许可与来源                                                                                                                   |
| -------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| mGBA WebAssembly           | `public/emulator/mgba.js`、`mgba.wasm`    | [MPL-2.0 全文](public/emulator/LICENSE-MPL-2.0.txt)；[来源、精确提交、WASM 校验值与本地修改](public/emulator/NOTICE.md)      |
| EmulatorJS、FCEUmm、Snes9x | `public/emulatorjs/`                      | EmulatorJS GPL-3.0、FCEUmm GPL-2.0、Snes9x 自有许可证；[版本、来源、校验值与本地修改](public/emulatorjs/NOTICE.md)           |
| wasm-dolphin、Dolphin      | `public/dolphin/`                         | GPL-2.0-or-later；[固定提交、核心校验值与许可](public/dolphin/NOTICE.md)                                                     |
| DM Sans 可变字体           | `public/fonts/dm-sans.ttf`                | [SIL Open Font License 1.1](public/fonts/OFL.txt)；[Google Fonts 源码](https://github.com/google/fonts/tree/main/ofl/dmsans) |
| Star Orbit 原创示例        | `public/demo/`、`scripts/create-demo.mjs` | [MIT License](public/demo/LICENSE.txt)；可复现的原创 GBA 程序、位图、字体及音效                                              |

### mGBA 的修改与源码

内核来自 [`@thenick775/mgba-wasm` 2.5.1](https://www.npmjs.com/package/@thenick775/mgba-wasm/v/2.5.1)，对应源码为 [thenick775/mgba 的固定提交](https://github.com/thenick775/mgba/tree/e974b288bd7e5cfc7c7b96f8b4d32b673ddfb68c)。感谢 Jeffrey Pfau、Nicholas VanCise 和所有 mGBA / WebAssembly 移植贡献者。

WASM 文件未修改。JavaScript 包装层增加宿主就绪/销毁方法，以及防止旧音频回调访问已释放内存的保护。完整修改源码随 `public/emulator/mgba.js` 分发，继续采用 MPL-2.0；修改范围详见该目录的 `NOTICE.md`。自有 TypeScript 适配层通过公开 API 调用它。

### FC / SFC 运行时

EmulatorJS 4.2.3 前端与固定版本的 FCEUmm / Snes9x WebAssembly 核心随仓库分发。核心归档未修改；前端仅增加应用托管的存档、禁用运行时更新、单页应用释放和所需控制入口。完整源码、许可证文本与精确校验值位于 `public/emulatorjs/`。

### GameCube 实验性运行时

浏览器运行时来自 `wasm-dolphin` 固定提交 `7e38409ace3dda709c178312ff63fd92a3653cc7`，其中 Dolphin 核心对应提交 `e22551eae1c84a7e4d0b6a5c519ef4ed4ef69df1`。运行时和核心未作源码修改；WASM SHA-256 为 `d7395b3a94080f5b7d08a0522f59096007419d117b7b0eb868246429adee6f5c`。上游将其定位为研究原型，本项目仅提供明确标记的实验性支持。

### ROM 与商标

仓库只包含原创 Star Orbit 试玩和测试时动态生成的原创最小 GB / GBC / NES / SNES ROM，不包含商业 ROM 或 Nintendo BIOS。标准启动识别数据仅用于格式与硬件兼容。Nintendo 主机与平台名称属于各自权利人，仅用于说明兼容格式；本项目与 Nintendo 无隶属、授权或背书关系。

## 前端运行依赖

版本锁定在 [`pnpm-lock.yaml`](pnpm-lock.yaml)。以下许可文本随生产构建复制到 `licenses/` 目录，以便静态站点分发时一起保留。

| 依赖                                                               | 用途           | 许可                               |
| ------------------------------------------------------------------ | -------------- | ---------------------------------- |
| [React](https://github.com/facebook/react) / React DOM / Scheduler | UI 与渲染      | MIT                                |
| [Lucide](https://github.com/lucide-icons/lucide)                   | 界面图标       | ISC；包含上游 Feather 图标许可声明 |
| [fflate](https://github.com/101arrowz/fflate)                      | ZIP 解压       | MIT                                |
| [@noble/hashes](https://github.com/paulmillr/noble-hashes)         | 大文件增量哈希 | MIT                                |

[合并许可文本](public/licenses/DEPENDENCIES.txt)保留各依赖的完整声明。构建、测试工具（如 Vite、TypeScript、Playwright、fake-indexeddb、Prettier）由包管理器安装，适用各自包中的许可证；不作为模拟器运行时资源直接分发。
