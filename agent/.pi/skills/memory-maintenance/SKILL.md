---
name: memory-maintenance
description: "Use for automated or idle housekeeping of repository memory: classify changed notes, merge duplicates, consolidate provisional person records, repair links, and remove obsolete copies under memory/."
---

# Memory maintenance

Maintain repository memory after durable notes change.

## Boundaries

- The Pi workspace is `agent/`; repository-root-relative `memory/...` paths resolve as `../memory/...`.
- Change only files under `../memory/`.
- Never write under `../system/` or treat memory as canonical operational state.
- Focus on the files listed in the request. Inspect other memory files only when needed to merge notes or check consistency.

## Organization

Classify by ownership and scope:

- one person → `memory/people/<slug>/README.md` and that person's directory
- multiple people or another shared owner → `memory/shared/<owner-type>/<slug>/...`
- repository-wide reference material → `memory/common/<topic>/...`

When a stable user-to-person link becomes available, merge provisional display-name-based notes into the canonical person location. Move clearly misfiled material and update links instead of retaining duplicate copies.

Do not impose frontmatter or another fixed schema unless code actually depends on it. Keep notes concise, preserve useful facts, and make no change when organization is already clear.

## Result

After applying changes, return a short summary of files created, updated, moved, or deleted; otherwise say no change.
