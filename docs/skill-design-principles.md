# Skill 设计原则（基于 Perplexity Agent Skills）

本文总结并本地化了 Perplexity 文章《Designing, Refining, and Maintaining Agent Skills at Perplexity》的核心思想，用作本仓库后续设计与维护 skill 的指导文档。

原文链接：<https://research.perplexity.ai/articles/designing-refining-and-maintaining-agent-skills-at-perplexity>

## 1. 先把 skill 看成“上下文工程”，不是普通文档

写 skill 的目标不是给人写 README，也不是把操作步骤机械抄进去；本质上是在为模型构造一份**高价值、低噪声、按需展开**的上下文。

因此：

- skill 的每个 token 都有成本
- skill 写得越像人类教程，通常越差
- skill 价值主要来自：**路由更准、行为更稳、边界更清楚、失败更少**

可用一句话判断：

> 如果模型不看这句也不会做错，这句就大概率不该留在 skill 里。

## 2. Skill 是目录，不只是 SKILL.md

一个好的 skill 应该是“hub-and-spoke”结构：

- `SKILL.md`：核心路由与高信号指导
- `scripts/`：确定性逻辑，避免模型每次现编
- `references/`：重型资料，仅在需要时读取
- `assets/`：模板、schema、样例
- 其他窄用途说明文件：只在特定条件下读

设计原则：

- `SKILL.md` 保持精炼
- 条件性、分支性、重内容放到旁路文件
- 如果领域很复杂，可以用更深层级帮助模型先缩小范围，再定位细节

## 3. Description 是“路由触发器”，不是简介

skill 的 `description` 最重要，也最容易写错。

它的作用不是介绍 skill 做什么，而是告诉模型：**什么时候该加载它**。

### 推荐写法

- 以 `Load when...` 开头
- 50 词左右为目标，越短越好
- 描述用户意图、常见说法、相邻边界
- 不描述实现流程

### 好例子

- `Load when the task is to add, replace, or interpret durable future-facing assistant rules such as “以后都要…” or “今后请遵守…”.`

### 坏例子

- `This skill manages rules through the CLI.`

前者能帮助路由，后者只是功能说明。

## 4. Skill 要渐进加载

把 skill 拆成三层成本来理解：

1. **索引层**：所有 skill 的 `name + description`
2. **加载层**：某个 skill 的 `SKILL.md`
3. **运行层**：脚本、参考资料、模板、子文件

因此本仓库应遵循：

- 所有 skill 描述必须尽量短、密、可区分
- `SKILL.md` 只放加载后仍值得长期占上下文的内容
- 大段参考资料、专项工作流、格式模板一律按需外置

## 5. 什么时候需要 skill，什么时候不需要

### 适合写 skill

当至少满足以下之一：

- 没有专门上下文时，模型经常做错
- 需要仓库本地知识、主观偏好、组织习惯
- 需要跨轮次/跨运行保持更稳定的一致性
- 有确定性逻辑，适合沉淀成脚本或模板

### 不适合写 skill

- 模型本来就会的通用命令序列
- 系统 prompt 已经覆盖的通用规则
- 快速变化、很难维护的外部接口细节
- 面向人的冗长教程

## 6. Body 要写“高信号”，不要写“流水账”

`SKILL.md` 主体要避免：

- 大段 step-by-step 命令
- 显而易见的工具使用教学
- 过度僵化、脆弱的固定流程

更推荐：

- 用意图级指令描述结果与约束
- 明确失败边界
- 强调常见误区与不要做什么
- 保留模型在正确性边界内的策略弹性

例如不要写：

- `git log ...; git checkout ...; git cherry-pick ...`

而写：

- `Cherry-pick the commit onto a clean branch. Resolve conflicts preserving intent. If it cannot land cleanly, explain why.`

## 7. Gotchas 是最高价值内容之一

随着 skill 维护，最该增长的往往不是主体流程，而是 gotchas：

- 代理常犯的错
- 易混淆的邻域边界
- 经常漏掉的条件
- 容易“看起来成功、实际没成功”的情况

维护原则：

- 观察一次真实失败，就考虑补一个 gotcha
- 优先追加 gotcha，而不是把主体写得越来越长
- 改 description 必须配套路由 eval

## 8. 先写 eval，再写或修改 skill

skill 设计应尽量 eval-first。

至少要覆盖：

- **正例**：该加载时能加载
- **反例**：不该加载时不加载
- **邻域混淆**：与相近 skill 的边界是否稳定
- **渐进读取**：需要时会不会去读 accessory files
- **端到端结果**：任务是否完成，是否满足约束

如果后续改了 description，却没有补 eval，通常说明这次修改风险较高。

## 9. Skill 是税，越多越要克制

每个 skill 都会增加：

- 全局索引成本
- 路由干扰风险
- 相邻 skill 的回归概率
- 维护负担

所以要坚持：

- 少而精
- 可删则删
- 能用现有 skill 边界表达清楚，就不要再拆新 skill
- 能放脚本/模板/引用文件，就不要硬塞进 `SKILL.md`

## 10. 对本仓库的直接落地要求

后续设计或重构 skill 时，统一遵循以下规则：

1. `description` 写成触发条件，不写成功能介绍。
2. `SKILL.md` 只保留高信号内容：边界、第一步、gotchas、条件读取指引。
3. 确定性逻辑优先下沉到脚本。
4. 重内容、低频内容、条件内容拆到旁路文件。
5. 不重复系统 prompt、代码约束、CLI 已确定的真实边界。
6. 不把“模型本来就知道的通用命令”写成 skill 主体。
7. 修改 description 或边界时，应同步补充 eval 思维或测试样例。
8. 技能库整体追求边界稳定，避免 skill 之间相互争抢路由。

## 11. 适合本仓库的简化模板

```md
---
name: skill-name
description: Load when [user intent / trigger language / boundary].
---

# Skill name

## Scope

- 这个 skill 负责什么
- 哪些相邻任务应交给别的 skill

## First action

- 首先做什么
- 需要时去读哪个附属文件

## Gotchas

- 常见失败
- 不要做什么
- 成功前不要声称已完成什么

## Runtime branches

- 条件 A → 读 `references/...`
- 条件 B → 运行 `scripts/...`
- 条件 C → 使用 `assets/...`
```

这个模板比传统“教程式 skill”更适合当前仓库。
