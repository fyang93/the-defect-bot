# 故障机器人

[English README](README.md)

一个本地优先的 Telegram bot，用于个人记忆、文件、日程，以及轻量的消息转达流程。

它通过 Pi SDK 运行，把规范事实保存在仓库里，并把 Telegram 视为平台适配器，而不是整个系统的中心。

## 它能做什么

- 记住并查询个人事实信息
- 整理上传的文件和资料
- 创建和管理日程
- 向已授权用户或已知群聊发送消息或定时投递内容
- 把 Telegram 上传的文件保存到 `tmp/` 里供处理；同名的新上传会直接覆盖旧的本地副本
- 让 admin 通过 bot 管理持久用户角色

## 架构

整体上，它是一个简洁的分层系统：bot 运行时、平台适配、Pi SDK 通道、Pi tools、领域事务、档案。面向 assistant 的确定性边界是 repository Pi tools，底层直接调用确定性 operations。最近一轮深挖已经把调度生命周期收口到 `ScheduleEngine`，把启动与运行时编排收口到 bot 生命周期模块，并把 Pi SDK 会话 / 资源生命周期收口到内部的 broker/cache 接缝。

```text
交互
  接收并发送用户消息
  |
  v
调度
  协调循环、会话与任务时机
  |
  +-- Assistant 通道
  |     主 Pi agent 负责理解请求与执行
  |     |
  |     +--> Pi tools -> Operations
  |     |      |
  |     |      +--> 事务 / 档案
  |     |             领域逻辑与规范持久状态
  |
  +-- Composer / Maintainer 通道
         短文本生成、维护摘要和窄任务
```

当前对话主流程以单助手通道为中心：

- bot runtime、确定性 operations、Pi tool backend 都收敛在 `src/bot/**`

- 助手直接理解请求；涉及确定性状态时通过 Pi tools 执行
- runtime 代码负责当前回合回复发布，确定性的仓库动作由 Pi tool backend 直接执行
- composer/writer 任务，例如启动问候、提醒文案、用户可见回复改写，使用窄的 no-tools/no-context Pi session
- maintainer 任务保持窄职责，不应意外获得当前回合投递或仓库修改能力
- runtime 代码负责等待态 UI、中断、启动阶段的短暂聚合 / 输入合并，以及避免重复发送
- i18n 保持最小化，只保留和 command / UI 直接绑定的文本；自然对话措辞交给模型生成
- assistant 的自然回复语言跟随用户实际对话语言，而固定 UI 文本跟随配置中的默认界面语言

### 会话作用域

短期对话上下文由 Pi SDK 会话按作用域保存：

- **私聊** -> 每个用户一个会话
- **群 / 超级群** -> 每个群一个会话

长期事实、访问角色、日程、结构化状态**不依赖**模型会话历史，而是保存在仓库状态中，例如：

- `system/users.json`
- `system/chats.json`
- `system/state.json`
- `system/events.json`

这些状态现在优先通过确定性代码路径和 Pi tools 管理，而不是继续依赖 prompt 里定义的大型持久化协议。项目级工程原则现在统一写在 `AGENTS.md` 和 `docs/principles.md`。

## Agent workspace

Pi assistant 资源集中放在 `agent/`：

- `agent/AGENTS.md`：bot assistant 指令；注入 bot SDK assistant session 和 `just agent`
- `agent/.pi/extensions/defect-bot-tools`：由直接 operations 支撑的 Pi tools，覆盖事件、用户/授权/规则和 Telegram 投递
- `agent/.pi/skills/memory`：仓库本地长期笔记、偏好与事实
- `agent/.pi/skills/custom-toolbox`：窄而专用的项目工具流程
- `agent/.pi/auth.json` 与 `agent/.pi/models.json`：本地凭证 / 模型配置，已被 git 忽略

常规确定性工作应优先使用 Pi tools，而不是 shell out。`just agent` 会用 `agent/.pi` 作为 Pi agent directory 打开交互式 Pi 会话，方便本地调试 assistant。

assistant / composer / maintainer 通道和资源加载规则见 `docs/agent-architecture.md`。

## 快速开始

```bash
cp config.toml.example config.toml
cp .env.example .env
just install
# 直接使用 Pi SDK；请在 agent/.pi/auth.json 或环境变量中配置模型凭证
just serve
# 可选：打开同一个 agent workspace 的交互式 Pi 会话
just agent
```

## 配置

至少填写：

- `telegram.bot_token`
- `telegram.admin_user_id`

典型配置：

```toml
[telegram]
bot_token = "YOUR_TELEGRAM_BOT_TOKEN"
admin_user_id = 333333333
waiting_message = "机宝启动中..."
input_merge_window_seconds = 3
menu_page_size = 8

[bot]
language = "zh-CN"
persona_style = "模仿杀戮尖塔里的故障机器人说话。"
default_timezone = "Asia/Tokyo"

[maintenance]
enabled = true
idle_after_minutes = 15

```

一些常用的可选项：

- `telegram.menu_page_size`：Telegram 内联菜单分页大小
- `telegram.input_merge_window_seconds`：将短时间内追加的文本/文件合并进同一轮进行中的窗口
- `telegram.waiting_message`：立即显示的初始等待文案；如果为空，就不显示初始等待消息
- `bot.language`：固定 UI 文本使用的默认界面语言；可选 `zh-CN` 或 `en`
- `bot.default_timezone`：用户未显式提供时使用的默认时区
- `maintenance.idle_after_minutes`：空闲多少分钟后触发 maintenance

## Telegram 使用前提

- 任何需要接收 bot 私聊消息的用户，都必须先主动和 bot 私聊一次。
- 如果要在群里使用这个 bot，需要去 **BotFather** 把该 bot 的 **Group Privacy** 关闭。

## 权限级别

- `allowed user`：可以和 bot 对话，但只能在自身 / 当前已关联对话上下文范围内使用低风险基础能力；可以上传 / 处理 `tmp/` 里的临时文件，但不能访问超出该范围的隐私信息，也不能写入持久 memory
- `trusted user`：可以读取和修改记忆、上传 / 处理文件、创建日程，以及使用其他持久化工作流
- `admin user`：在 trusted 的基础上拥有管理权限，例如管理持久角色和发放临时授权

当前代码已经在 assistant 主通道里落实了 allowed user 的隐私边界：allowed user 会被限制在 allowed-user scope 内，不能获取超出 linked conversation context 的隐私信息。

admin 也可以对某个 `@username` 做临时授权，并指定任意有效期。之后，对方只要在临时授权过期前和 bot 发生一次可识别交互，系统就能关联该账号并授予访问权限。这可以是私聊，也可以是在群里 `@bot`，或者在群里回复 bot 的消息。

Telegram 的延迟投递现在建模为 scheduled events，由 bot schedule engine 投递。

## 使用示例

- “记一下我的护照号。”
- “我的家庭住址是什么？”
- “提醒我明天早上 9 点提交申请。”
- “发给 @someone：晚饭好了。”
- “把这条消息发到家庭群。”
- “把 @someone 设为 trusted。”

## 命令

- `/help`
- `/new`
- `/model`（仅 admin）

## 测试

```bash
npm test
npm run test:nl
npm run test:live
just test
```

`just serve` 会直接启动 bot；模型/供应商访问由 Pi SDK 解析。

当前回归测试覆盖了确定性的存储行为和真实自然语言流程，包括日程 CRUD、用户访问级别变更、外发消息、符合 persona 的用户可见文案，以及按用户时区换算后注入的时间上下文。
