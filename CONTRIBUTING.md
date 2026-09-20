# 参与 Orbitra 开发

感谢你帮助改善 Orbitra。文档、问题复现、设备兼容性记录、界面改进与代码贡献都很有价值。本项目主要使用中文沟通，也欢迎英文 Issue 和 PR。

## 提交问题或建议

在 [Issues](https://github.com/hehuang139/orbitra/issues) 搜索是否已有相同问题。Bug 报告请尽量包含：

- 操作系统、浏览器名称与版本、设备或手柄型号。
- 使用环境：本地开发、生产部署，及是否通过 HTTPS 访问。
- 从启动页面开始的最小复现步骤，以及实际 / 预期行为。
- 浏览器控制台错误与必要截图；分享前移除个人信息。
- 能否用仓库内的 Star Orbit 试玩重现；若不能，请提供游戏标识与相关现象。

请勿上传无权分发的商业 ROM、BIOS、素材或含个人数据的完整浏览器存储。原创试玩 ROM 是首选复现资源，有明确再分发许可的自制 ROM 也可以用于测试。

功能建议应描述要解决的问题、操作场景与期望效果。较大改动建议先通过 Issue 讨论，尤其是核心升级、存储格式、云服务与跨平台支持。

## 本地环境

推荐 Node.js 24、pnpm 11.19.0 和支持 WebAssembly 线程的现代浏览器。最低 Node.js 版本为 22.18。如尚未安装 pnpm，先运行 `npm install --global pnpm@11.19.0`。

```sh
git clone https://github.com/hehuang139/orbitra.git
cd orbitra
pnpm install --frozen-lockfile
pnpm dev
```

贡献代码时，通常先 Fork 仓库，再从自己的 Fork 克隆并创建工作分支。开发地址为 `http://localhost:5173`；Vite 已设置内核所需的 COOP / COEP 响应头。普通 HTTP 局域网地址不满足运行要求，移动设备联调应配置 HTTPS。

项目使用 pnpm 锁文件。修改依赖后请同步 `pnpm-lock.yaml`，避免加入其他包管理器的锁文件。

## 代码分工

| 路径                                                                   | 职责                                               |
| ---------------------------------------------------------------------- | -------------------------------------------------- |
| `src/App.tsx`                                                          | 游戏库、播放器、设置与存档交互                     |
| `src/styles.css`                                                       | 响应式布局、主题与触屏样式                         |
| `src/emulator/index.ts`                                                | mGBA 生命周期、输入、音频与存档接口                |
| `src/emulator/battery-snapshot.ts`                                     | 从核心原生快照提取电池存档，校验边界与解压大小     |
| `src/hooks/useGamepads.ts`、`src/lib/gamepad.ts`                       | 手柄轮询、按设备配置、录入与输入聚合               |
| `src/lib/input.ts`、`src/lib/touch.ts`                                 | 输入来源管理、触屏配置与多指按键                   |
| `src/components/TouchControls.tsx`、`src/components/TouchSettings.tsx` | 触屏控件、布局与设置                               |
| `src/lib/platforms.ts`                                                 | 平台标识、扩展名、分辨率、大小限制与输入能力注册表 |
| `src/lib/storage.ts`                                                   | IndexedDB 数据与存档持久化                         |
| `src/lib/backup-format.ts`                                             | 版本化备份 ZIP、边界检查、引用关系与 SHA-256 校验  |
| `src/components/BackupManager.tsx`                                     | 批量导出、只读预览、冲突选择与存储整理             |
| `src/lib/import-roms.ts`                                               | ROM / ZIP 校验、解压与大小限制                     |
| `src/lib/preferences.ts`                                               | 用户偏好与默认按键                                 |
| `scripts/`                                                             | 自制 ROM 生成和浏览器集成检查                      |
| `public/emulator/`                                                     | 随应用分发的第三方核心及许可证                     |

沿用周边 TypeScript 与 React 风格，优先小范围、有明确目的的改动。异步存取档、切换游戏、内核启动和释放涉及并发状态，应保留已有的生命周期保护。

不要手动编辑生成的 `dist/`、`.artifacts/` 或 `node_modules/`。更新第三方内核时，须同步精确版本、来源、修改说明、许可证与必要的兼容性验证。

## 验证改动

基础检查：

```sh
pnpm test
pnpm build
```

`pnpm test` 运行存储、ZIP、环境探测、输入与偏好配置单元测试，以及 `src/emulator/battery-snapshot.test.ts` 中的原生快照边界、重复数据、大小限制和解压检查。`pnpm build` 包含 TypeScript 检查与生产构建。浏览器集成检查使用真实核心和原创试玩 ROM，不需要商业游戏文件。

首次运行浏览器检查时：

```sh
pnpm exec playwright install chromium
```

Linux 上若缺少浏览器系统依赖，可使用 `pnpm exec playwright install --with-deps chromium`。在另一个终端保持 `pnpm dev` 运行，然后按改动范围选择检查：

```sh
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

| 检查             | 适用改动                                                                         |
| ---------------- | -------------------------------------------------------------------------------- |
| `test:engine`    | 核心适配、输入、画面、音频、倍速、倒带与资源释放                                 |
| `test:platforms` | GBA / GB / GBC 导入、筛选、原生比例、平台输入与持久化                            |
| `test:ui`        | 游戏库、交互、键盘、移动端布局与触屏控件                                         |
| `test:zip`       | ZIP 导入、错误处理、去重与解压后的游戏启动                                       |
| `test:saves`     | 自动存档、`.sav` 导入、刷新恢复与多游戏隔离                                      |
| `test:keyboard`  | 纯键盘导入、启动、暂停、存取档、退出及对话框焦点进入 / 限制 / 恢复               |
| `test:gamepad`   | 模拟 Gamepad API；按键 / 轴录入、死区、配置恢复、共享输入、断连 / 失焦和访问异常 |
| `test:touch`     | 合成指针、多点输入、取消 / 捕获丢失、触屏设置与 320px / 手机 / 横屏布局          |
| `test:startup`   | 环境与存储失败路径、首帧等待、启动超时及加载中释放                               |
| `test:backup`    | 下载校验、预览取消、冲突选择、空白环境含 / 不含 ROM 恢复、旧实例隔离、键盘与窄屏 |

测试默认连接 `http://127.0.0.1:5173`，支持以下可选环境变量：

| 变量                      | 用途                                                      |
| ------------------------- | --------------------------------------------------------- |
| `ENGINE_TEST_URL`         | 内核检查的服务地址                                        |
| `UI_TEST_URL`             | 界面、ZIP、存档、键盘、手柄、触屏与启动流程检查的服务地址 |
| `BROWSER_EXECUTABLE_PATH` | 使用本机已安装的 Chromium / Chrome / Edge 可执行文件      |
| `PLAYWRIGHT_MODULE`       | 指定 Playwright 模块的文件 URL                            |

内核检查使用 `src/emulator/verify.html` 开发测试页；手柄和启动检查还会对 Vite 返回的开发模块进行测试插桩，因此这些套件需要连接 `pnpm dev` 服务。测试入口不加入生产构建，也不要把调试全局对象加进应用代码。界面、ZIP 与存档流程则可以检查生产预览服务，例如在 PowerShell 中：

```powershell
# 另一终端先运行 pnpm build 和 pnpm preview
$env:UI_TEST_URL = 'http://127.0.0.1:4173'
pnpm test:ui
pnpm test:platforms
pnpm test:zip
pnpm test:saves
```

测试截图写入 `.artifacts/`，默认不纳入版本控制。UI 改动请同时检查桌面和窄屏状态，并在 PR 中提供相关截图。为修复添加测试时，优先覆盖用户可观察的行为和可能再次出现的故障。

输入回归中的 Gamepad API 和指针事件是合成输入，手机尺寸为 Playwright 视口模拟。请在 [兼容性记录](docs/compatibility-matrix.md) 分别注明自动化、模拟和实体设备结果；不能据此确认真实手柄、Android / iOS、屏幕阅读器或低性能设备已通过。首帧等待和当前 SRAM 的回归应保留真实核心执行，避免固定延时掩盖时序问题；原生电池快照提取只处理核心生成的数据，不将其作为用户上传即时存档的解析入口。

GitHub Actions 会执行构建、单元测试、浏览器集成检查，以及试玩 ROM 和依赖许可证的可复现检查；配置见 [.github/workflows/ci.yml](.github/workflows/ci.yml)。

## 更新首页截图

启动 `pnpm dev` 并安装 Playwright Chromium 后，运行：

```sh
pnpm screenshots
```

脚本在独立浏览器上下文中使用原创试玩，通过真实界面操作生成 `docs/images/` 中的桌面游戏库、播放器、存档与移动端截图。可用 `SHOWCASE_URL` 指向其他本地服务地址。更新截图后请检查画面、布局和图片体积，不要用个人游戏或用户存档替换公共展示资源。

## 修改原创试玩

试玩由 `scripts/create-demo.mjs` 生成，无需额外 ARM 编译器：

```sh
pnpm demo:build
```

如果修改生成脚本，请提交对应 ROM 与符号表，并运行内核和存档检查。资源要求及玩法见 [public/demo/README.md](public/demo/README.md)。

## 提交 Pull Request

1. 创建描述改动目的的分支，保持一个 PR 聚焦一个问题。
2. 完成实现和与改动相关的测试；更新受影响的文档。
3. 检查 diff，避免提交个人 ROM、存档、浏览器配置、密钥与构建产物。
4. 在 PR 中说明原问题、改动后的行为、验证命令与尚未验证的范围。
5. 关联相关 Issue；界面改动附效果图，存储或核心改动说明兼容性影响。

不要将尚未实现的规划写成已完成能力。如果测试因设备或环境限制无法运行，请直接注明缺失的验证及原因。

## 许可证与第三方资源

应用代码与原创试玩采用 [MIT](LICENSE)。提交相关贡献意味着同意按对应文件的许可条款分发；mGBA 桥接修改继续遵循 MPL-2.0，字体和其他第三方资源保留原许可证。

引入依赖、图像、字体或测试 ROM 时，请确认允许再分发，记录上游来源并补充 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。运行时依赖升级后，执行 `pnpm licenses:generate` 并提交生成的 `public/licenses/DEPENDENCIES.txt`。既有核心来源和修改说明位于 [public/emulator/NOTICE.md](public/emulator/NOTICE.md)。
