# The Defect Bot

一个由 Pi SDK 驱动的本地优先飞书机器人，用于个人记忆、文件、日程、提醒、自动化和消息转达。

## 功能

- 飞书私聊直接响应；群聊中被 @ 时响应
- 支持文字、图片、文档、音频和视频
- 用本地 `system/` JSON 保存用户、群聊、事件和运行状态
- 用 `memory/` 保存长期记忆
- 所有飞书用户能力相同：都可以管理记忆、文件、日程、模型和消息转达
- 支持 `/help`、`/new`、`/stop`、`/quota`、`/reminders`、`/model`
- 支持“新建会话”“剩余额度”“当前提醒”“切换模型”飞书自定义菜单

## 启动

```bash
just install
cp config.toml.example config.toml
# 在 .env 中配置 FEISHU_APP_ID 和 FEISHU_APP_SECRET
just agent  # 如果 agent/.pi/auth.json 尚无可用凭证，先执行一次 /login
just serve
```

飞书应用需要启用机器人能力和长连接事件订阅，并订阅消息接收事件及 `application.bot.menu_v6`。按需授予消息读取、发送、文件资源读取和消息表情回应权限。事件型自定义菜单可分别使用 `new_session`、`remaining_quota`、`current_reminders`、`switch_model` 作为事件键；发送同名中文文本的菜单也受支持。

## 配置

```toml
[feishu]
app_id = "${FEISHU_APP_ID}"
app_secret = "${FEISHU_APP_SECRET}"
input_merge_window_seconds = 3
menu_page_size = 8
```

`config.toml` 支持从项目 `.env` 和进程环境变量展开 `${VAR}`。

## 开发

```bash
npm run check
npm test
npm run test:live
```

- 运行入口：`src/bot/main.ts`
- 飞书适配：`src/bot/feishu/**`
- 确定性操作：`src/bot/operations/**`
- Pi workspace：`agent/`
