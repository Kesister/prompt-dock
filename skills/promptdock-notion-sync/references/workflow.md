# 同步规则与操作

## 目标与私有状态

没有默认数据库。首次使用请用户提供其自己的目标数据库链接，fetch 验证它是数据库并取得实际数据源 ID。多数据源时让用户选择；不拿视图 ID 或数据源 ID 代替数据库 ID。工具能力和图片上传协议以本次连接器实际可用接口为准；不支持时报告限制，不推测执行成功。

令 `<target>` 为核实后的数据库 ID 或官方数据库链接。脚本会正规化为 32 位数据库 ID；将状态保存在技能目录之外的使用者私有目录，例如 `<private-state-dir>/<database-id>.json`。首次状态不存在时按首次接管处理。更换目标使用独立状态；换电脑可携带对应状态，但不要分享状态、配置和迁移文件。没有状态则不伪造基线。

`<skill>`、`<job>`、`<state>` 均须换成本次机器上的实际路径，含空格时加引号。Windows 可使用 `python -X utf8`；本技能不要求固定用户名、操作系统路径或某个原项目。

## 托管字段

| 字段 | 类型 | 来源 |
|---|---|---|
| 名称 | title | title |
| 标签 | multi_select | tags，保留 `/`，空数组不伪造标签 |
| 使用说明 | rich_text | usageNote，保留原文 |
| 收藏 | checkbox | favorite |
| 使用次数 | number | useCount |
| 变体数量 | number | variants.length |
| 图片数量 | number | imageRefs.length |
| 原始创建时间 | date，带时间 | createdAt |
| 原始修改时间 | date，带时间 | updatedAt |
| Prompt Dock ID | rich_text | id，稳定关联键 |

不恢复「默认版本名称」。空说明也清空托管值；不得因空值漏填。日期比较正规化到分钟（Notion 会丢弃秒）；标签顺序无意义，图片和变体顺序有意义。新增缺失托管字段可作为同步步骤，已有类型不符先问。其他字段不碰。`Notion 备注` 存在则保留，不必为了同步创建。标签选项必须并入现有选项而非重置颜色/删除选项。

## 三方比较

基线只存 sourceFingerprint、remoteFingerprint、sourceUpdatedAt、pageUrl，不存正文、图片字节或短期签名链接。

- 新 ID 且远端没有：create。
- 两边都与基线相同：skip。
- 仅 source 改：update；不同内容且时间早于基线：stale，需确认。
- 仅 remote 改：notion_only，保留远端，不推进基线。
- 两边都改：实际托管内容一致可 adopt，否则 conflict。
- 无基线但远端有 ID：内容一致才能 adopt；不一致 conflict，不默认源文件优先。
- 重复远端 ID：duplicate_remote，不更新、不自动删。
- 文件缺失或 deletedAt：报告 missing/deleted，不删除。条目大幅减少可能来自旧快照/不同库/主动删减，先问，不能凭数量自动判断。
- Notion 最后编辑时间不是冲突依据，改备注也会触发它。 sourceUpdatedAt 是辅助信号，不是绝对“新旧”证明。

## 执行

1. 在当前任务内建立工作目录，运行 `python <skill>/scripts/sync.py prepare <source.promptdock> --out <job> --target <target>`。检查 ZIP、格式版本、ID、图片路径与 SHA-256。当前支持 formatVersion 4；未知版、缺图、重复 ID 等停止，不静默丢图。原文件只读。
2. fetch self/get_tool_access（按可用工具）、目标数据库与 `notion://docs/enhanced-markdown-spec`。500/权限错误不改用浏览器；最多两次只读重试后停止，不把服务 500 说成数据库缺权限。
3. 查询全部行，处理分页；逐页 fetch 有源 ID 的记录，保存内层 fetch 对象 `{url,text,title,...}` 数组为 `remote-raw.json`，不打印正文/签名链接。用 `snapshot --raw <raw> --out <remote.json>` 正规化；工具返回 content 文本为 JSON 时先解包。
4. `plan --prepared <prepared.json> --remote <remote.json> --state <state> --out <plan.json> --target <target>`。报告数量，无冲突自动执行。stale/conflict/unreadable/duplicate_remote 保护不写；无 ID 页面不认领、不修改。同名不可替代 ID。
5. 正文按 prepared 的 body 结构生成，字段逐项填写。日期拆成 `date:原始创建时间:start/is_datetime` 等；checkbox 为 `__YES__`/`__NO__`；标签按 schema 格式。代码块保留原文不转义，其他富文本按 Notion spec 转义。变体为普通二级标题，无折叠。标题只在名称字段。
   - 新/改变图片用 Notion create_file_upload ticket，HTTPS api.notion.com，multipart `file` POST 一次，带全部返回 headers。`upload --file <image> --ticket-json '<ticket JSON>'` helper 可用；失败要新 ticket，不复用一次性 URL。网络权限按产品机制申请，不索要永久 token。
   - 不变图片重用当前 fetch 的图块/file ID，不重复上传。签名链接不是永久缓存；状态只存文件摘要。改变的图片按原顺序插入。不能从长期旧 signed URL 重新导入。
   - 更新前再 fetch，与计划快照不同则重算。精确 update_content 优先，动态图片签名可能让全段匹配失败，应以稳定片段操作或在已授权托管正文范围整体替换。正文额外人工文本是冲突；不丢掉它。
   - 小批创建，每批记下 ID→pageUrl；超时/结果未知先查库再重试，避免重复。
6. 写后 fetch、snapshot；核对全部托管属性、正文、变体、图片顺序及普通标题，无截断。`commit --prepared <prepared> --remote <after> --state <state> --ids <verified-ids.json> --target <target>` 只推进回读内容与源一致的条目，失败/仅远端改动项不推进。
7. 查总数与 ID 唯一性，保存报告，再告诉用户实际完成。源词库/回收站只作未导入提示。

## helper 文件

- prepare 输出 `prepared.json` 与 `images/`，不写原备份。默认只导出活跃 Prompt。
- snapshot 输入实际 fetch 内层对象数组，输出 `entries`；托管正文外内容与异常结构影响 remoteFingerprint，故人工添加不会被默认为无变化。
- plan 不写 Notion；commit 原子写状态。状态绑定目标数据库 ID；禁止把另一库的 state 拿来用。
- 缺失 state：相同内容 adopt，不同内容 conflict。换电脑需携带 state；状态不是定时任务。
- upload token 仅短期内存/命令参数使用，禁止写入技能、状态、日志或输出。不要把私密工作目录提交 Git。

每次给新文件重新 prepare，不复用旧 source 内容。分享包只包含指令、脚本和合成测试；运行产生的真实数据不属于可分享的技能资源。
