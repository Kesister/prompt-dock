# 可选扩展：Prompt Dock → Notion

[返回首页](../README.md)

这是配套的 **Codex Skill**，不是 Prompt Dock 安装包，也不是软件内置的实时云同步。

它读取你主动提供的 `.promptdock` 备份，单向增量同步到你自己的 Notion 数据库：按原始 ID 去重，识别旧备份与双边修改冲突，不自动删除页面。图片、Prompt 和变体可以放入页面正文；默认不导入词库与回收站。

## 下载

[下载 Skill 分享版 ZIP](https://github.com/Kesister/prompt-dock/releases/download/skill-notion-sync-v1.0.0/promptdock-notion-sync-share.zip) · [查看该版本说明](https://github.com/Kesister/prompt-dock/releases/tag/skill-notion-sync-v1.0.0)

分享版不包含作者的数据库、账户凭据或同步记录，也不会随软件自动安装。

## 首次使用

1. 将 ZIP 交给 Codex，明确要求安装 `promptdock-notion-sync`，先不要同步。
2. 连接自己的 Notion 插件／连接器，并确认目标数据库有读写权限。
3. 新开聊天，提供自己的 `.promptdock` 文件与已有 Notion 数据库链接。当前分享版会检查并补齐字段，不默认创建数据库。
4. 辅助脚本需要 Python 3.10+，可让 Codex 先检查环境。

建议从 3 条测试开始：

```text
使用 $promptdock-notion-sync，把我提供的 .promptdock 文件同步到这个 Notion 数据库：[填写链接]。
先检查连接和运行环境，只导入 3 条测试。不要删除已有页面，遇到冲突先告诉我。
```

核对后再要求全部同步。以后提供新备份即可增量更新；保留本地同步状态，换电脑时私下迁移。

同步意味着你选择的内容会发送到自己的 Notion 工作区。请自行确认目标页面的共享权限；不要把个人备份、凭据或同步状态上传到公开仓库。

[Skill 源码](../skills/promptdock-notion-sync/SKILL.md) · [字段映射、冲突与同步规则](../skills/promptdock-notion-sync/references/workflow.md)
