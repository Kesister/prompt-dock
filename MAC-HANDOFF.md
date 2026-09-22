# Windows / macOS 共用源码开发交接

## 当前状态与分支

本仓库基于 Windows v0.10.13（`44dadf078a9e72d6c7886593bd94319869826131`），在 `mac-support` 分支补充 macOS 支持，保留版本号。两个平台共用同一项目、同一份依赖锁文件和同一套业务逻辑；`mac-support` 是待合并的功能分支，不是长期独立的 Mac 产品线。

仓库保持私密。安装包、个人 Prompt/词库、图片资料库、备份及 node_modules 不提交。随程序发布的作者头像、微信二维码继续保留。安装包生成不等于公开发布。

Windows 开发者先保存自己的工作，再同步此分支：

```sh
git status --short
git fetch origin
git switch --track origin/mac-support
# 若已有本地 mac-support，则 git switch mac-support，再 git pull --ff-only
npm ci
```

如已有其他开发分支，先检查差异再合并 `origin/mac-support`；不要覆盖本地修改或强制推送。完成 Windows 回归和代码评审后，将功能分支合并回 main，两端随后继续从 main 开发。不要另建一份 renderer/storage 或复制出独立 Mac 仓库。

## 源码边界与平台差异

| 范围 | 共享实现 / Windows | macOS |
| --- | --- | --- |
| Prompt、标签、变体、词库、回收站、图片、备份 | `renderer.js`、`storage.js`、`main.js` 的共同业务逻辑 | 同一实现、SQLite 与 `.promptdock` 格式，无平台专用资料格式 |
| 系统判断 | `main.js` 使用 `process.platform` | `preload.js` 只读暴露平台，renderer 根据 `IS_MAC` 选择键位 |
| 搜索 / 新建 / 图片复制 | Ctrl+K / Ctrl+N / Ctrl+C | ⌘K / ⌘N / ⌘C |
| 默认全局唤出 | Control+Alt+P | Command+Alt+P；两端均可录制自定义组合 |
| 快捷键冲突 | 注册新组合成功后才释放旧组合；失败不写回设置 | 同一逻辑，不用默认值覆盖用户设置 |
| Prompt 直接粘贴 | 保留 `PromptDock.WinHelper.exe` 与短暂 blur 的 Ctrl+V 流程 | `PromptDock.MacHelper.swift` 监听最近外部应用，确认目标并发送 ⌘V；需辅助功能授权 |
| 词库单击 | 只复制，不调用原生粘贴助手 | 同一行为 |
| 菜单与恢复 | 原托盘、全局唤出、单实例恢复 | 加入原生编辑菜单、Dock activate 恢复；菜单栏沿用 Tray |
| 窗口尺寸 | 普通尺寸、超小尺寸分别保存 | 同一持久化逻辑 |
| 打包 | `dist` / `dist:installer`，Windows helper 仅进 Windows 包 | `dist:mac`，Swift helper 作为 extraResources，仅进 Mac 包 |

不要给普通输入框点击添加 `app.focus()`、`mainWindow.focus()`、重复 show/activate 或重绘逻辑。弹窗打开时聚焦一次；启动器的主动唤回与外部粘贴目标的切换才涉及窗口激活。

`storage.js` 未分叉。导入只合并资料，不导入 Windows 快捷键、备份路径等本机设置。源码同步不会同步用户资料，跨设备资料迁移仍通过 `.promptdock`。

## 开发与构建

共同要求：Node.js 22、Git，使用 `npm ci` 按锁文件安装；不要跨平台复制 node_modules。

Windows（PowerShell）：

```powershell
npm.cmd ci
npm.cmd start
npm.cmd run test:smoke
npm.cmd run dist
npm.cmd run dist:installer
```

Windows 不需要 Swift 或 Xcode。Mac 辅助程序不会在 Windows 启动；已有 C# helper 及打包脚本保留。

macOS（需 Xcode Command Line Tools）：

```sh
npm ci
npm run start:mac
npm run test:smoke
npm run dist:mac
```

`start:mac` 先编译 Swift helper。`dist:mac` 当前在 Apple Silicon Mac 生成 arm64 DMG/ZIP。Intel helper 的编译脚本支持本机 x86_64，但 Intel 发行包与实机尚未验证，不能把 arm64 包当作 Intel 版本。构建结果在被 Git 忽略的 `build/`、`dist/`。

当前 Mac 包采用 ad-hoc 本地签名，没有 Developer ID 身份签名，未完成 Apple 公证。正式分发前需配置签名、公证和实际安装验收，不要把本地包标为正式公证发行版。

## 隔离测试步骤

### 两端自动回归

`npm run test:smoke` 使用同一 Node 脚本，在系统临时目录自动创建新的独立资料目录，忽略已有的 `PROMPT_DOCK_USER_DATA`。不使用日常资料库。退出码非零表示启动失败、超时、缺失结果或检查失败。

控制台给出目录；其中保留 `smoke.log`、`smoke-result.json`、测试截图和测试资料用于排查。目录可能含导入备份的副本，不要上传或提交它。

要验证迁移，使用自己准备的非生产 `.promptdock`，或经允许只读使用备份：

```powershell
# Windows PowerShell
$env:PROMPT_DOCK_TEST_BACKUP = 'C:\test-data\sample.promptdock'
npm.cmd run test:smoke
Remove-Item Env:PROMPT_DOCK_TEST_BACKUP
```

```sh
# macOS
PROMPT_DOCK_TEST_BACKUP=/absolute/path/sample.promptdock npm run test:smoke
```

验证经过导入解析、合并、SQLite 保存、再次导出；检查 Prompt 全字段、图片原始字节、词库分类与字段、重复导入及源文件哈希。它不上传内容。一般 smoke 模式中的直接粘贴是模拟结果，不能代替真实跨应用粘贴验收。

### 两端交互验收

先在独立资料目录启动，禁止填日常资料目录：

```powershell
$env:PROMPT_DOCK_USER_DATA = Join-Path $env:TEMP ('prompt-dock-manual-' + [guid]::NewGuid())
npm.cmd start
# 退出后清理环境变量；不要删除用户资料目录
Remove-Item Env:PROMPT_DOCK_USER_DATA
```

```sh
PROMPT_DOCK_USER_DATA="$(mktemp -d /tmp/prompt-dock-manual.XXXXXX)" npm run start:mac
```

1. 新建/编辑 Prompt，加入标签、变体和图片；验证搜索、收藏、词库复制、回收站恢复及备份导入导出。词库点击不能向外部程序粘贴。
2. 验证本平台搜索/新建/图片复制快捷键，以及自定义全局唤出。用第二个测试程序占用组合键，确认保存失败时原设置和原有效组合不变。
3. 在相同测试资料目录重复启动第二个实例，确认它退出且原窗口唤回。关闭窗口后通过托盘/菜单栏、Dock（Mac）、全局快捷键恢复。
4. 切换置顶、超小模式；调整两种窗口尺寸，退出进程再启动确认记忆。覆盖多屏、全屏空间、浅色/深色菜单栏。
5. 连续点击和输入搜索框、新建表单，观察焦点是否稳定、有没有闪屏。
6. 在空白外部文本编辑器聚焦输入框，点击 Prompt 和变体，核对接收端正文；不能只看“已粘贴”提示。Windows 另测权限较高的目标程序并记录限制。
7. Mac 先拒绝辅助功能权限，确认正文已复制、显示提示、可手动 ⌘V；再由用户授权后测试真实自动粘贴。不得自动修改系统授权或绕过系统安全限制。
8. 从各自安装包复制/安装后重跑关键步骤，确认包内没有个人数据且原生 helper 与平台匹配。

### Mac 原生接收端复现

已有 `scripts/native-paste-target.swift` 是空白 Cocoa 接收端，含标准 Paste 菜单，收到文本会写入隔离目录。可按以下步骤编译（仅创建忽略目录下的测试 app）：

```sh
mkdir -p build/PasteTarget.app/Contents/MacOS
xcrun swiftc -module-cache-path build/module-cache scripts/native-paste-target.swift -o build/PasteTarget.app/Contents/MacOS/PasteTarget
cat > build/PasteTarget.app/Contents/Info.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.promptdock.testtarget</string>
<key>CFBundleExecutable</key><string>PasteTarget</string>
<key>CFBundleName</key><string>PasteTarget</string>
<key>CFBundlePackageType</key><string>APPL</string>
</dict></plist>
PLIST
PROMPT_DOCK_USER_DATA="$(mktemp -d /tmp/prompt-dock-native.XXXXXX)" \
PROMPT_DOCK_NATIVE_TEST="$PWD/build/PasteTarget.app/Contents/MacOS/PasteTarget" npm run start:mac
```

检查隔离目录 `native-result.json` 的 `passed: true` 与 `native-pasted.txt`。安装包权限需单独验证：用 `open -n -a '/path/Prompt Dock.app' --env PROMPT_DOCK_USER_DATA=/absolute/fresh/profile --env PROMPT_DOCK_NATIVE_TEST=/absolute/PasteTarget` 启动，避免继承开发工具的授权而误判安装版。

ad-hoc 重建会改变签名。如果系统辅助功能开关已开，仍返回 PERMISSION，先核对是否为旧构建；系统日志的 “Failed to match existing code requirement” 表示签名不匹配。由用户先移除旧授权条目，再添加最终 app 并开启。仅反复开关或重复添加同名 app 可能不能更新旧授权。最终包授权后不再重新签名或替换它。

## 已验收与尚未验收（2026-09-23）

已在 arm64、macOS 26.6.2、Node 22.22.0、锁文件 Electron 37.10.3 上完成：

- 162 项布尔回归检查通过，包含快捷键、资料功能、图片、备份、回收站、普通/超小窗口尺寸、真实第二进程退出并唤回原窗口、冲突保留原快捷键。
- 获授权备份只读往返比对通过，包括文字、图片字节、标签、变体和词库；源文件未改动。
- 开发版与用户授权后的最终安装版均向独立 Cocoa 接收端粘贴成功，中文文本逐字一致。
- DMG 只读挂载、解包、LaunchServices 启动与代码签名严格校验通过。Mac 包不含 Windows helper 和个人资料。

仍需 Windows 端实机运行及安装包回归、Intel Mac 验证；多个第三方输入框、安全输入、全屏与多显示器、菜单栏不同外观及长时间焦点观察尚未完全覆盖。Dock 自动测试调用 activate 事件，不代表已完成物理点击的人工验收。

原锁文件 `npm ci` 报告 8 项审计问题（1 moderate、7 high）；此次未做强制依赖升级。后续安全升级须同步评估两端，不单独替换 Mac 依赖。
