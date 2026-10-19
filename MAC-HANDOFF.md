# Mac 开发交接

## 当前状态

main 分支已更新至 Windows v0.11.0。已有 mac-support 分支独立保留，本次同步不覆盖其 Mac 平台适配，也不代表已交付 Mac v0.11.0。
本版新增 Windows 快捷调用浮窗、只读预览和作者页改版；保留单实例锁、重复启动唤出已有窗口、快捷键注册失败保留设置的修复。

仓库不含个人 Prompt 库、词库、备份或历史安装包。作者页保留头像，微信二维码已从当前源码分发清单移除，改用 GitHub 与问题反馈链接。历史提交可能仍含曾经发布的二维码，未来公开仓库前应再次确认资源及其使用权。

## 从 Mac 接续 v0.11.0

在 Mac 先保存并提交本机修改，再获取远端更新。将 main 的更新合并到 mac-support 时，人工检查 main.js、preload.js、renderer.js、package.json 和打包配置的冲突；不要用 Windows 文件整份覆盖已有 Mac 实现。
新增的 SlashHelper、FocusGrant 是 Windows 专用原生助手；不要在 macOS 编译或运行。Mac 侧应保留自己的输入定位、辅助功能权限、Command 键和打包逻辑，再适配共享的预览 UI 与作者页面。
下方待办是初始迁移检查清单，并非对现有 Mac 分支完成度的重新评估。本次 Windows 同步没有执行 Mac 运行或打包测试。

## 在 Mac 同步和运行

先安装 Node.js 22 LTS 和 Git，并使用自己的 GitHub 账号登录以访问私密仓库。
在 GitHub 仓库页面复制 HTTPS 克隆地址，然后在终端执行：

```sh
git clone <从仓库页面复制的地址>
cd prompt-dock
npm ci
npm start
```

`npm ci` 使用锁文件中的依赖版本；不要把 Windows 的 node_modules 复制到 Mac。
以后更新前先保存并提交本机修改，再运行 `git pull --ff-only`；锁文件有变化时重新运行 `npm ci`。
如有分支分歧，应检查并合并，避免使用强制覆盖命令。

## Mac 适配待办

- 在 Mac 实测主窗口、托盘/菜单栏、Dock 点击唤出、关闭后恢复、置顶和超小窗口。
- 将界面快捷键及录制逻辑适配 Command：搜索、新建、图片复制等；全局唤出允许自定义。
- `main.js` 的直接粘贴当前仅支持 Windows；Mac 暂用复制后手动 Command+V。必须实现并实测 Mac 粘贴与辅助功能权限，不能运行 Windows helper。
- 在 package.json 添加 Mac 构建目标、图标与资源过滤，分别验证 Apple Silicon 和 Intel；不要直接运行现有 Windows 打包脚本。
- 确认 Mac 上的单实例与快捷键冲突行为。现有 smoke 测试含 Windows 键位与布局假设，需要适配后再用于 Mac 验收。
- 正式分发前在 macOS 构建并完成签名、公证和实际安装测试；未签名开发包不能视为正式发布完成。

## 资料迁移

源码同步不等于资料同步。在 Windows 内手动导出 `.promptdock`，在 Mac 版中导入；先用测试资料验证图像、变体、词库和标签均完整。
个人导出包不要提交到 Git。`.gitignore` 使用根目录白名单，新增源码目录时需明确加入白名单。

## 后续发布

保留 Windows 稳定版本，Mac 适配建议使用 `mac-support` 分支。两端共享源码，用平台条件隔离系统行为。
公开仓库、选择开源许可证与公开发布安装包是不同操作，当前只进行私密源码托管。
