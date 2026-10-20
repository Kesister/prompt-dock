# Mac v0.11.1 本地对齐

2026-10-20，Apple Silicon arm64。对照 Windows 固定提交 `1fee92ca415bec20fcd5d66f56649392b1dfe31d`，保留 Mac 分支 `ce4b3a4c117b91573a98d72b99fedc21b7a76356` 的共享源码适配。

本轮仅本地开发、构建与验证。**未上传，等待用户确认本次 Mac 成品。** 不因本地测试通过而发布。

## 行为

- Windows 与 macOS 共用主程序、界面、SQLite 和 `.promptdock` 格式。
- Mac 主窗口唤出 `⌘⌥P`，搜索 `⌘K`，新建 `⌘N`，图片复制 `⌘C`。快捷调用默认关闭，默认 `⌘⇧Space`，注册冲突时保留旧设置。
- Mac 原生 helper 先完成就绪握手；核对目标应用、可编辑控件、选区和内容后才发送 `⌘V`。识别到密码控件跳过，无法验证或权限不足时保留复制；不发送 Enter。
- 快捷调用使用共享浮窗搜索、版本与只读预览；没有输入符号触发或输入日志。
- 更新使用 MacUpdater，关闭自动下载和退出自动安装，安装前等待保存并核对完整备份。Mac 手动下载只选择固定仓库、对应架构的 DMG。
- 当前是 ad-hoc 试用包，未公证；正式身份验证失败时阻止内置下载安装，保留检查入口与说明。没有改变应用身份或真实资料目录。

## 已验证

- 共享单元测试 30/30。
- 最终打包 `.app` 的界面、数据、窗口与升级备份回归 181/181。
- 修复包通过真实 Cocoa 输入测试 4/4：正常直接粘贴、浮窗版本粘贴、密码框跳过、只读回退。此测试从终端启动，会继承宿主辅助功能权限，不能证明 Finder 启动后的应用授权。
- 独立 Chromium 接收器逐字回读 8/8：普通输入框、多行、富文本、对应三类浮窗插入、密码框和只读回退。同样属于终端授权范围。
- 浮窗专项预览、方向键、版本切换、复制正文、偏好与窄窗布局测试。
- DMG 只读挂载、LaunchServices 启动、严格 ad-hoc 签名完整性、Mac 元数据版本/尺寸/SHA-512 与包内资源白名单。
- Windows 原生关键输入代码的原有哈希回归通过，Windows helper 保持专属平台打包。

完整截图、逐项对照表与原始结果位于本地交付物的验收说明与 evidence 目录。所有测试均为隔离资料，未覆盖真实库或安装目录中的旧版。

## 尚未验收

本机有效代码签名身份为 0；当前线上 v0.11.1 仅有 Windows 资产。正式签名、公证、原生 Squirrel 安装替换与线上 Mac 更新链仍未验收。MacUpdater 下载测试使用本地源和真实下载/校验实现，原生安装边界是测试替身，不能作为系统安装成功证据。

Intel Mac、Windows 实机、多显示器、全屏/Spaces、其他第三方输入控件/输入法和图片超限人工操作尚未完成。

## 直接粘贴修复与权限边界

用户反馈 Edge 搜索框只提示复制。正常 LaunchServices 启动旧包和修复包均复现 `accessibilityTrusted: false` 与 `permission`，接收器没有收到输入；系统设置中的旧同名已开启条目没有覆盖当前应用副本。上一轮仅凭终端输入测试宣布直接粘贴通过，缺少这一验证边界。

修复后，主窗口直接粘贴先激活最近的目标应用，再识别并连续核对当前可编辑控件。浮窗继续核对唤出前的严格快照。助手不再在应用失去焦点时读取和缓存输入内容。设置及浮窗补充实际授权状态、准确副本定位和系统授权入口；权限不足时清楚说明原因。

当前修复版的普通启动已验证，授权拒绝路径按预期保留剪贴板。用户明确允许重新授权并完成触控 ID 后，仅重置 `com.codex.promptdock` 的 Accessibility 旧记录，再通过系统设置添加准确的 fix1 副本；正常启动后应用内已显示「辅助功能已授权，可以直接粘贴」。系统日志已证实此前存在代码签名要求不匹配，重复添加和切换旧开关仍绑定旧安装版。

正常 LaunchServices 启动的当前副本已在实际 Edge 地址和搜索栏完成主窗口直接粘贴，完整中文示例逐字回读一致，页面仍为 about:blank，没有提交搜索。快捷浮窗的真实系统热键测试仍待用户物理按键确认；自动化快捷键被 Edge 自身处理，不视为系统热键测试通过。不能将终端测试或系统设置中的同名开关代替实际输入回读。详见本地 `outputs/fix1/` 的修复说明和原始证据。

## 复现

```sh
npm ci
npm test
npm run build:mac-helper
npm run test:preview
npm run test:smoke
npm run test:native:mac
npm run test:browser:mac
npm run dist:mac
npm run test:smoke -- "/absolute/Prompt Dock.app/Contents/MacOS/Prompt Dock"
npm run test:native:mac -- "/absolute/Prompt Dock.app/Contents/MacOS/Prompt Dock"
```

`dist:mac` 内含唯一的 `--publish never`，不要重复追加。原生测试创建有独立 bundle ID 的 Cocoa 接收器，不在用户其他应用中输入。辅助功能授权应绑定最终安装副本。
