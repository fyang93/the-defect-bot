# 故障机器人

[English README](README.md)

一个本地优先的 Telegram bot，用于个人记忆、文件、日程、提醒、自动化和轻量消息转达。

它通过 Pi SDK 提供 assistant 能力，把长期状态保存在本地仓库文件中，并把 Telegram 当作聊天入口，而不是事实来源。

## 功能

- 记住并查询个人事实信息
- 整理 Telegram 上传的文件，供本地处理
- 创建提醒、日程、周期任务和自动化
- 向已授权用户或已知群聊即时 / 定时发送消息
- 通过 bot 管理用户访问级别

## 快速开始

```bash
cp config.toml.example config.toml
just install
# 配置 Telegram 和 Pi 模型凭证后：
just serve
```

Pi 模型凭证可以放在 `agent/.pi/auth.json`、`agent/.pi/models.json`，或使用支持的环境变量。

本地调试 assistant：

```bash
just agent
```

## 配置

至少填写：

- `telegram.bot_token`
- `telegram.admin_user_id`
- `bot.default_timezone`

常用选项：

- `telegram.waiting_message`：初始等待文案；留空则不显示
- `telegram.input_merge_window_seconds`：短时间内追加文本 / 文件的合并窗口
- `telegram.menu_page_size`：Telegram 内联菜单分页大小
- `bot.language`：固定 UI 语言，`zh-CN` 或 `en`
- `bot.persona_style`：assistant 人设提示
- `maintenance.enabled`：是否启用空闲维护

## Telegram 设置

- 需要接收 bot 私聊消息的用户，必须先主动和 bot 私聊一次。
- 如果要在群里使用 bot，需要在 BotFather 里关闭该 bot 的 **Group Privacy**。

## 权限级别

- `allowed`：基础聊天，以及当前关联上下文内的低风险操作
- `trusted`：记忆、文件、日程、自动化和其他持久化工作流
- `admin`：trusted 权限外加角色管理和临时授权

## 示例

- “记一下我的护照号。”
- “我的家庭住址是什么？”
- “提醒我明天早上 9 点提交申请。”
- “发给 @someone：晚饭好了。”
- “把这条消息发到家庭群。”
- “把 @someone 设为 trusted。”

## 命令

- `/help`
- `/new`
- `/model` — 仅 admin

## 开发

```bash
npm run check
npm test
npm run test:live
```

工程规则见 `AGENTS.md`；bot assistant workspace 细节见 `docs/agent-architecture.md`。
