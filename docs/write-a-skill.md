---
name: write-a-skill
description: Load when creating, rewriting, reviewing, or restructuring an agent skill or skill library. Covers routing descriptions, progressive loading, gotchas, eval-first design, and when to move deterministic logic into scripts or accessory files.
---

# Writing Skills

Follow a skill philosophy closer to Perplexity's Agent Skills than to ordinary README writing: skills are context packages, every token is a tax, and the main job is to improve routing and behavior without hurting adjacent skills.

## Core ideas

- A skill is a directory, not just one markdown file.
- The description is a routing trigger, not internal documentation.
- Keep `SKILL.md` lean; move heavy, conditional, or deterministic content into accessory files.
- Focus on what the model gets wrong without the skill.
- Prefer gotchas and negative examples over obvious step-by-step commands.
- Write or at least define eval cases before polishing the body.

## When a skill is justified

Create or keep a skill only when at least one of these is true:

- The agent is consistently wrong without special context.
- The domain needs durable local knowledge not reliably present in model training.
- You need stable behavior across runs, not just a one-off prompt nudge.
- There is deterministic logic or output shaping better implemented as code or templates.

Usually do **not** create a skill for:

- generic tool usage the model already knows
- restating system-prompt instructions
- fast-changing external APIs or tool inventories that will drift quickly
- long human-oriented documentation with little new signal

Test every sentence with: **Would the agent get this wrong without this line?** If not, cut it.

## Recommended process

1. **Write evals first**
   - Include positive loads, negative loads, and neighbor-confusion cases.
   - Capture known failures that motivated the skill.
   - If changing a description later, update routing evals too.

2. **Write the description**
   - Start with `Load when...`
   - Target about 50 words or fewer.
   - Describe user intent and trigger language, ideally from real requests.
   - Do not summarize the workflow.

3. **Write the body**
   - Keep it short and high-signal.
   - Skip obvious commands the model already knows.
   - Prefer flexible intent-level guidance over brittle command sequences.
   - Add gotchas, edge cases, and boundaries with neighboring skills.

4. **Use hierarchy deliberately**
   - Put deterministic code in `scripts/`.
   - Put heavy docs in `references/` or focused notes under the skill.
   - Put templates, schemas, and examples in `assets/`.
   - Keep `SKILL.md` as the hub that points to conditional detail.

5. **Iterate and ship**
   - Tune routing before expanding body text.
   - Favor append-mostly gotcha updates over broad rewrites.

## Skill structure

```text
skill-name/
├── SKILL.md
├── scripts/        # deterministic logic the agent should run, not reinvent
├── references/     # heavy docs read only when needed
├── assets/         # templates, schemas, examples
└── ...             # narrowly scoped helper notes or subdirectories
```

Use deeper hierarchy only when it helps the model choose among large conditional branches.

## SKILL.md template

```md
---
name: skill-name
description: Load when [user intent, trigger language, boundary].
---

# Skill name

## Scope

- What this skill is for
- What nearby tasks belong elsewhere

## Quick route or first action

- Minimal first step
- Link to conditional detail only when needed

## Gotchas

- High-value failure cases
- Things not to do

## Runtime notes

- Read `references/...` when [condition]
- Run `scripts/...` when deterministic work is needed
```

## Description guidance

A good description helps routing with minimal spillover.

Checklist:

- Starts with `Load when...`
- Mentions user intent, not implementation detail
- Includes adjacent boundaries when confusion is likely
- Dense and terse; every word must earn its cost

Good:

```text
Load when the task is to add, replace, or interpret durable future-facing assistant rules such as “以后都要…” or “今后请遵守…”, rather than storing ordinary facts or changing one event.
```

Bad:

```text
This skill manages rules through the CLI and supports adding and replacing them.
```

The bad version explains capability but gives weak routing triggers.

## What belongs outside SKILL.md

Move content out of the body when it is:

- deterministic code the agent would otherwise regenerate
- long reference material needed only after a condition is met
- output templates or schemas to copy/fill
- specialized branch logic for one narrow workflow

Example patterns:

- `scripts/fill_research_worklog.py`
- `references/api-errors.md`
- `assets/report-template.md`
- `tools/<workflow>.md` for a focused local helper note

## Maintenance guidance

- Skills are append-mostly.
- Grow the gotchas section from real failures.
- Tighten descriptions only with routing eval support.
- Re-check neighboring skill boundaries whenever adding a new skill or changing routing text.
- Prefer small wording changes with evidence over large untested rewrites.

## Review checklist

- [ ] The description is a routing trigger, not a summary
- [ ] Positive and negative load cases exist
- [ ] `SKILL.md` contains only high-signal guidance
- [ ] Obvious command sequences were removed
- [ ] Deterministic logic moved to scripts/templates where appropriate
- [ ] Boundaries with neighboring skills are explicit
- [ ] Gotchas capture known failure modes
