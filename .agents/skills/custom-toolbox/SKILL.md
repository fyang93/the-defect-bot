---
name: custom-toolbox
description: Handles narrow project-specific utility workflows that do not belong to memory, cli-events, cli-access, cli-rules, or cli-telegram. Use when the task matches a small local helper flow such as filling a 研究業務日誌 .xlsx workbook and returning the generated file.
---

# Custom toolbox

## Quick start

- If the user uploaded a `.xlsx` file whose filename contains `研究業務日誌` and asked to fill or auto-complete it, read [tools/research-worklog-xlsx.md](tools/research-worklog-xlsx.md).

## Workflows

### Route correctly

Do not use this skill when the task clearly belongs to:

- `memory`
- `cli-events`
- `cli-access`
- `cli-rules`
- `cli-telegram`

Use this skill when the task is a narrow project-specific utility flow and the main work is described by a local tool note in this directory.

### General rules

- For Python helpers, use `uv run ...` rather than bare `python3`.
- Manage Python dependencies with uv rather than pip.
- Do not claim the output file was generated unless the script succeeded.
- Do not claim the file was returned to the user unless the delivery step succeeded.
- Keep the final user-visible reply short and outcome-focused.
