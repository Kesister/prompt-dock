# Mac 开发交接

2026-10-21，Mac v0.11.1 已完成本机验收，用户明确要求同步 GitHub。开发分支为 [`mac-support`](https://github.com/Kesister/prompt-dock/tree/mac-support)，安装包位于独立的 [Mac 预览版下载页](https://github.com/Kesister/prompt-dock/releases/tag/mac-v0.11.1)。Windows `main` 与稳定版保留。

## 共享源码与平台边界

Windows/macOS 共用主程序、界面、SQLite 和 `.promptdock` 格式，平台差异使用条件分支。Mac 版对齐 Windows v0.11.1 固定提交 `1fee92ca415bec20fcd5d66f56649392b1dfe31d`，原有 Mac 适配继续保留。

- `assets/PromptDock.MacHelper.swift` 和 `mac-input.js` 负责 Mac 输入定位、权限及原生粘贴；Windows 的 C# 输入助手不能在 Mac 运行。
- 主窗口 `⌘⌥P`，搜索 `⌘K`，新建 `⌘N`；快捷调用默认关闭，开启后默认 `⌘⇧Space`，`Tab` 确认。
- 快捷浮窗预加载，定位等待设短时限；助手未就绪或目标不响应时及时显示并回退复制。无法验证输入位置时不模拟粘贴。
- 不注册输入符号触发，不记录输入内容；密码控件跳过，粘贴不发送 Enter。

完整变更、原始测试范围及限制见 [Mac 验证说明](docs/MAC-VALIDATION.md)。已验收的运行代码提交为 `15431b925228a62e5ee2dbf4164b363cf377a017`；后续同步提交只更新文档。

## 开发与构建

在 Mac 安装 Git、Node.js 22 和 Xcode Command Line Tools，使用本机依赖：

```sh
git clone --branch mac-support https://github.com/Kesister/prompt-dock.git
cd prompt-dock
npm ci
npm run start:mac
```

测试必须使用隔离的绝对路径 `PROMPT_DOCK_USER_DATA`，不得导入覆盖、重置或删除真实资料库。原生测试会短暂占用焦点和剪贴板；辅助功能权限应绑定最终安装的应用副本。

```sh
npm test
npm run build:mac-helper
npm run test:preview
npm run test:smoke
npm run test:native:mac
npm run test:browser:mac
node scripts/test-mac-palette-latency.js
npm run dist:mac
node scripts/build-mac-installer.js "/absolute/Prompt Dock.app" "/absolute/output"
```

`dist:mac` 已固定使用 `--publish never`。完整 PKG 包含 Electron 与原生助手，固定安装到 `/Applications/Prompt Dock.app`，不需要启动脚本或外部 Node.js。安装包不含个人资料，没有安装前后脚本；解包后的应用与已测应用逐项一致。

## 发行与接续

本轮源码同步到 `mac-support`，Mac 安装包单独使用 `mac-v0.11.1` 标签，不改动 Windows 稳定版，也不触发只监听 `v*` 标签的 Windows 发布工作流。当前包未做 Developer ID 签名及公证，作为预览版分发，内置自动安装更新保持停用；线上 Mac 更新链和 Intel Mac 尚未验证。

以后同步主分支更新时，人工检查主程序、界面、快捷调用、更新和打包配置的冲突，避免整份 Windows 文件覆盖 Mac 实现。不使用强推，不上传真实库、备份、测试输出或账户凭据。安装包放在 Releases，不写入源码历史。

资料迁移使用应用导出的 `.promptdock`，先在隔离库验证文字、图片、变体、词库和标签。源码同步不等于个人资料同步。
