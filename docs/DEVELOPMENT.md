# 开发指南

[返回首页](../README.md) · [贡献说明](../CONTRIBUTING.md)

## 范围与结构

`main` 当前为 Windows v0.11.3。项目使用 Electron、原生 JavaScript/CSS、本地 SQLite 与 Windows C# 输入助手。

| 位置 | 用途 |
| --- | --- |
| `main.js` / `preload.js` | 桌面窗口、IPC、快捷键与系统集成 |
| `renderer.js` / `index.html` / `styles.css` | Prompt、词库和设置界面 |
| `motion.js` / `motion.css` | 面板、菜单、弹窗和小窗内容过渡；在 renderer.js 之前加载脚本 |
| `storage.js` | 本地库、图片存储与数据维护 |
| `slash-*` / `slash.html` / `slash.css` | 快捷调用与预览；沿用历史文件名，不代表仍支持符号触发 |
| `assets/PromptDock.*.cs` | Windows 原生输入及焦点助手 |
| `scripts/` / `tests/` | 构建和回归测试 |
| `skills/promptdock-notion-sync/` | 可选的 Notion 同步 Skill |

## 本地运行

准备 Git、Node.js 22 和 npm。Windows 原生助手构建还需要系统的 .NET Framework 4.x C# 编译器与 WPF/UI Automation 程序集；具体路径见 `scripts/build-slash-helper.js`。

```powershell
git clone https://github.com/Kesister/prompt-dock.git
cd prompt-dock
npm ci
npm start
```

开发运行可能读取同一账户下的应用资料。不要用自己的唯一一份资料库测试迁移或删除；先导出备份，并使用隔离的测试环境。

## 测试

纯逻辑与配置检查：

```powershell
npm run test:slash
node --test tests/author-links.test.js tests/installer-config.test.js
```

桌面和原生交互检查（Windows）：

```powershell
npm run test:preview
node scripts/smoke-test.js
node tests/native-slash.test.js --popup
node tests/native-slash.test.js --acquisition
```

桌面测试使用临时样例和测试窗口，但原生交互测试会短暂占用焦点、键盘及剪贴板。请先暂停其他输入工作，不要在正在编辑重要资料时运行。

## 打包 Windows

```powershell
npm run build:slash
npm run build:focus
npm run dist:installer
```

安装包默认输出到 `dist/Prompt-Dock-版本号-Setup.exe`。生成便携包：

```powershell
npm run dist
```

打包前检查版本、原生助手与 `build.files`。安装包只能包含程序资源，不应包含个人库、备份、测试输出或账户凭据。EXE、ZIP 与演示视频放在 **GitHub Releases 或 GitHub 附件中**，不要提交到源码历史。

## macOS

适配分支为 [`mac-support`](https://github.com/Kesister/prompt-dock/tree/mac-support)。不要用 Windows 文件整份覆盖该分支；Windows 原生助手不能在 macOS 运行。参阅 [Mac 交接与验证清单](../MAC-HANDOFF.md)。

## 发布检查

1. 核对版本号，运行相关测试；测试通过不代表所有外部应用都支持直接粘贴。
2. 在干净环境检查安装、启动、升级、退出及卸载后的数据保留行为。
3. 检查包内容，确认没有个人数据和意外资源。
4. 为发布源码创建版本标签；在 Releases 上传安装包和 SHA-256，写明平台、已知限制及升级方法。
5. 保持 README 的下载链接指向应用发行版，不把可选 Skill 的发布误当作软件更新。

