# macOS 开发指南

[返回首页](README.md) · [Mac 使用说明](docs/MAC-USER-GUIDE.md) · [测试说明](docs/MAC-VALIDATION.md)

Mac 适配位于 [`mac-support`](https://github.com/Kesister/prompt-dock/tree/mac-support) 分支。项目沿用 Windows/macOS 共享源码，通过平台条件分支处理系统集成。Mac v0.11.4 支持 Apple Silicon、macOS 12 及以上版本。

## 运行项目

需要 Git、Node.js 22 和 Xcode Command Line Tools。

```sh
git clone --branch mac-support https://github.com/Kesister/prompt-dock.git
cd prompt-dock
npm ci
PROMPT_DOCK_USER_DATA="/absolute/test-profile" npm run start:mac
```

开发运行请使用绝对路径 `PROMPT_DOCK_USER_DATA` 指定独立测试目录，避免测试操作影响日常使用的资料库。依赖需在 Mac 本机安装。

## 平台模块

| 文件 | 职责 |
| --- | --- |
| `main.js`、`preload.js` | 窗口、菜单栏、快捷键与系统集成 |
| `renderer.js`、`storage.js` | 共享界面、SQLite 与资料格式 |
| `slash-controller.js`、`slash-*` | 快捷浮窗、搜索、版本选择与预览 |
| `mac-input.js` | 原生输入助手通信 |
| `assets/PromptDock.MacHelper.swift` | 辅助功能权限、输入位置校验与粘贴 |
| `mac-update.js` | Mac 更新检查和安装条件 |

Windows C# 输入助手仅用于 Windows。合并跨平台改动时，应保留原有平台分支并运行相应回归检查。

## 构建安装包

```sh
npm run dist:mac
node scripts/build-mac-installer.js "/absolute/Prompt Dock.app" "/absolute/output"
```

`dist:mac` 生成 arm64 应用、DMG 与 ZIP，并固定使用 `--publish never`。PKG 构建脚本接收已测应用，封装为标准系统安装向导，固定安装到 `/Applications/Prompt Dock.app`。

安装载荷只包含应用程序。脚本会验证架构和签名完整性，并在完整解包后比较文件内容、执行权限与符号链接。安装包不携带用户资料，也不设置安装前后脚本。

## 版本发布

安装包及校验文件通过 Releases 分发，源码历史不保存安装包、个人库、备份或测试输出。Mac 标签使用 `mac-v版本号`，Windows 的 `v*` 标签沿用现有发布工作流。平台补丁独立编号：Windows 与 Mac 当前均为 v0.11.4；Mac 构建号为 11401。

Mac v0.11.4 起作为正式版发布，设置 `prerelease=false`、`make_latest=false`，保留 Windows 的 Latest 入口。旧 Mac 预览发布继续保留原有标记。Mac 更新检查从 Releases 列表中选择对应架构的 Mac 安装包，支持 `mac-v` 标签，优先下载 PKG；不会读取 Windows 的 `latest.yml`。

正式版发布状态与 Apple 签名、公证是独立状态。当前 Mac 安装包尚未完成 Apple Developer ID 签名与公证，下载页需保留说明，软件内自动安装更新保持停用。Intel Mac 与线上 Mac 自动更新链尚未验证。
