# macOS 测试说明

[开发指南](../MAC-HANDOFF.md) · [Mac 使用说明](MAC-USER-GUIDE.md)

测试环境为 Apple Silicon，覆盖 Mac v0.11.1 的共享界面、资料处理、原生输入和安装载荷。

## 测试命令

```sh
npm ci
npm test
npm run build:mac-helper
npm run test:preview
npm run test:smoke
npm run test:native:mac
npm run test:browser:mac
node scripts/test-mac-palette-latency.js
```

桌面测试使用隔离资料。自行启动应用验证时，应设置绝对路径 `PROMPT_DOCK_USER_DATA`。原生测试会短暂占用焦点和剪贴板，请暂停其他输入操作。

## 功能覆盖

| 检查 | 覆盖内容 | v0.11.1 结果 |
| --- | --- | --- |
| 单元检查 | 搜索、配置、作者链接、更新与下载逻辑 | 30/30 |
| 打包应用烟雾检查 | 界面、资料、窗口及升级备份 | 181/181 |
| Cocoa 输入接收器 | 主窗口与快捷浮窗填入、密码跳过、只读回退 | 4/4 |
| Chromium 输入接收器 | 普通输入框、文本域、富文本及其浮窗路径，密码和只读保护 | 8/8 |
| 浮窗预览 | 方向键、版本切换、复制正文、偏好与窄窗布局 | 通过 |
| 安装载荷 | 架构、签名完整性、解包文件内容、权限及符号链接 | 通过 |

原生接收器通过逐字回读确认是否收到内容。终端启动的测试可能继承测试宿主辅助功能权限，不能替代安装副本的系统授权检查。实际应用的权限状态可在「Mac 直接粘贴权限」中查看。

## 快捷浮窗性能

运行：

```sh
node scripts/test-mac-palette-latency.js "/absolute/Prompt Dock.app"
```

性能测试从快捷键回调进入开始计时，到浮窗可见、候选渲染完成且搜索框聚焦结束。正常样本开始前确认接收器已恢复前台焦点。该指标不包含系统将物理热键交给应用之前的耗时。

| 场景 | 可交互耗时 |
| --- | ---: |
| 首次唤出 | 84.9 毫秒 |
| 10 次正常唤出中位数 | 13 毫秒 |
| 1200 条合成 SQLite 资料 | 46.5 毫秒 |
| 目标不响应辅助功能消息 | 145.9 毫秒 |
| 原生助手未就绪 | 214.6 毫秒 |

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

## 已知覆盖范围

当前包未做 Apple 开发者签名与公证。正式签名、公证、原生 Squirrel 替换与线上 Mac 自动更新链尚未验证，自动安装更新保持停用。

Intel Mac、Windows 实机、完整多显示器/全屏/Spaces 覆盖，以及其他第三方控件和输入法仍需进一步测试。
