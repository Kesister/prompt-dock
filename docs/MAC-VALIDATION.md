# macOS 测试说明

[开发指南](../MAC-HANDOFF.md) · [Mac 使用说明](MAC-USER-GUIDE.md)

测试环境为 Apple Silicon，覆盖 Mac v0.11.2（构建 11201）的共享界面、资料处理、原生输入和安装载荷。

## 测试命令

```sh
npm ci
npm test
npm run build:mac-helper
npm run test:preview
npm run test:smoke
npm run test:native:mac
npm run test:browser:mac
PROMPT_DOCK_BROWSER_EDGE=1 npm run test:browser:mac
node scripts/test-mac-palette-latency.js
```

桌面测试使用隔离资料。自行启动应用验证时，应设置绝对路径 `PROMPT_DOCK_USER_DATA`。原生测试会短暂占用焦点和剪贴板，请暂停其他输入操作。

## 功能覆盖

| 检查 | 覆盖内容 | v0.11.2 结果 |
| --- | --- | --- |
| 单元检查 | 搜索、配置、作者链接、更新与下载逻辑 | 33/33 |
| 打包应用烟雾检查 | 界面、资料、窗口及升级备份 | 181/181 |
| Cocoa 输入接收器 | 主窗口与快捷浮窗填入、密码跳过、只读回退 | 4/4 |
| Chromium 输入接收器 | 默认可访问性状态下的输入框、选区替换、文本域、富文本、小窗变体和浮窗；密码与只读保护 | 13/13 |
| Edge 访客窗口 | 与 Chromium 接收器相同的 13 项操作，使用独立浏览器资料目录和本机验证页 | 13/13 |
| 浮窗预览 | 方向键、版本切换、复制正文、偏好与窄窗布局 | 通过 |
| 安装载荷 | 架构、签名完整性、解包文件内容、权限及符号链接 | 通过 |

本次 Edge 普通输入用例首次运行时，测试浏览器未在准备时限内启动，未进入填入步骤；单独重跑通过。其余 12 项一次通过，Chromium 13 项与 Cocoa 4 项均一次通过。

原生接收器通过逐字回读确认是否收到内容。终端启动的测试可能继承测试宿主辅助功能权限，不能替代安装副本的系统授权检查。实际应用的权限状态可在「Mac 直接粘贴权限」中查看。

## 浏览器首次识别

Chromium/Electron 可能延迟提供网页输入框的辅助功能信息。旧测试接收器强制启用了 `force-renderer-accessibility`，未覆盖默认状态；当前接收器默认关闭该测试开关，同时覆盖已有文字全选替换。需要对照已启用状态时，可显式设置 `PROMPT_DOCK_BROWSER_FORCE_ACCESSIBILITY=1`。新签名接收器的首次可执行文件启动检查在测试准备阶段完成；每个用例仍启动新的接收进程，保持可访问性树未预先启用。

原生助手在进入目标应用时读取应用角色并请求可访问性信息。Electron 使用其公开的 [`AXManualAccessibility` 接口](https://www.electronjs.org/docs/latest/tutorial/accessibility)，Chrome 类浏览器使用 `AXEnhancedUserInterface`。Electron 37.10.3 的[对应实现](https://github.com/electron/electron/blob/v37.10.3/shell/browser/mac/electron_application.mm#L328)会等待两秒合并请求，因此同一运行实例不重复发送成功的启用请求；启动繁忙导致的失败允许重试。

快捷浮窗定位仍限制在 200 毫秒以内。若浏览器正在初始化，先记录前台应用和窗口；选择 Prompt 后回到该窗口，等待并核对可编辑输入框。已有控件快照的会话仍校验同一控件、选区与内容。密码、只读区域、目标窗口变化和提交前剪贴板变化均停止直接粘贴。浏览器刚启动时，首次填入可能需要等待辅助功能信息就绪，这不会阻塞浮窗展示。

Edge 测试使用 `--guest` 和独立的绝对资料路径，避免账户引导页遮挡输入框。接收页必须实际获得焦点才能报告就绪。密码与只读测试必须收到对应拒绝原因，不能仅凭“没有文字进入”判定通过。

## 快捷浮窗性能

运行：

```sh
node scripts/test-mac-palette-latency.js "/absolute/Prompt Dock.app"
```

性能测试从快捷键回调进入开始计时，到浮窗可见、候选渲染完成且搜索框聚焦结束。正常样本开始前确认接收器已恢复前台焦点。该指标不包含系统将物理热键交给应用之前的耗时。

| 场景 | 可交互耗时 |
| --- | ---: |
| 首次唤出 | 88.7 毫秒 |
| 10 次正常唤出中位数 | 14.0 毫秒 |
| 1200 条合成 SQLite 资料 | 76.7 毫秒 |
| 目标不响应辅助功能消息 | 210.1 毫秒 |
| 原生助手未就绪 | 221.2 毫秒 |

以上为构建 11201 的性能运行，10 次正常唤出的最大值为 88.7 毫秒。此前构建 11102 的一次运行出现过 502.6 毫秒的渲染峰值，定位阶段约 1 毫秒；这些数据不是所有负载下的响应上限。

正常样本保留直接填入，超时样本使用复制回退。测试另覆盖延迟就绪恢复，以及慢目标返回后助手能继续处理后续命令。

实现采用隐藏浮窗预加载、覆盖助手启动等待的短定位时限，以及逐条辅助功能消息时限。超时请求不会在助手就绪后补发；输入位置仍需通过目标应用、控件、选区和内容校验。

## 打包应用与安装检查

```sh
npm run dist:mac
npm run test:smoke -- "/absolute/Prompt Dock.app/Contents/MacOS/Prompt Dock"
npm run test:native:mac -- "/absolute/Prompt Dock.app/Contents/MacOS/Prompt Dock"
npm run test:browser:mac -- "/absolute/Prompt Dock.app/Contents/MacOS/Prompt Dock"
node scripts/build-mac-installer.js "/absolute/Prompt Dock.app" "/absolute/output"
```

`dist:mac` 已包含 `--publish never`。PKG 解包后的应用应与输入的已测应用逐项一致。系统安装器目标条件检查、安装向导检查和实际执行系统安装属于不同检查；载荷一致不代表系统安装或更新链已经通过验证。

## Mac 独立更新检查

v0.11.2 使用 Mac 发布记录检查版本，识别 `mac-v` 标签与对应架构的 PKG，兼容旧 DMG。单元测试覆盖混合 Windows/Mac 发布、Mac 预览通道、草稿过滤、版本排序、分页、同版与降级过滤、错误重试，以及禁止自动安装。Windows 更新控制器和下载校验回归一并通过；本轮未运行 Windows 实机。

## 已知覆盖范围

当前包未做 Apple 开发者签名与公证。正式签名、公证、原生 Squirrel 替换与线上 Mac 自动更新链尚未验证，自动安装更新保持停用。

Intel Mac、Windows 实机、完整多显示器/全屏/Spaces 覆盖，以及其他第三方控件和输入法仍需进一步测试。
