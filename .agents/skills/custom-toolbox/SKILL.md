---
name: custom-toolbox
description: Load when the task is a narrow project-specific utility workflow with a dedicated local helper note or script, and it does not primarily belong to memory, cli-events, cli-access, cli-rules, or cli-telegram. E.g., autofilling a 研究業務日誌 .xlsx workbook and returning the generated file.
---

# Custom toolbox

## Scope

Use this skill only for small project-specific helper flows whose main procedure is captured by a local note or script in this directory.

Do not use this skill when the task primarily belongs to:

- `memory`
- `cli-events`
- `cli-access`
- `cli-rules`
- `cli-telegram`

## First action

- If the user uploaded a `.xlsx` file whose filename contains `研究業務日誌` and asked to fill or auto-complete it, read [tools/research-worklog-xlsx.md](tools/research-worklog-xlsx.md).
- Otherwise, find the narrow helper note or script that exactly matches the requested utility flow.

## Gotchas

- Do not stretch this skill into a generic fallback for miscellaneous tasks.
- Prefer the more specific neighboring skill whenever the task's primary truth boundary is memory, event state, access state, durable rules, or Telegram delivery.
- For Python helpers, use `uv run ...` rather than bare `python3`.
- Manage Python dependencies with uv rather than pip.
- Do not claim the output file was generated unless the script succeeded.
- Do not claim the file was returned to the user unless the delivery step succeeded.
- Keep the final user-visible reply short and outcome-focused.
