# The Defect Bot engineering agent guide

This repository is a local-first Telegram bot backed by the Pi SDK. Keep deterministic state changes in code/tools, keep prompts small and purpose-specific, and avoid committing local credentials or runtime state.

## Quick start

- Install: `just install`
- Typecheck: `npm run check`
- Unit/regression tests: `npm test`
- Live tests: `npm run test:live`
- Run bot: `just serve` or `just s`
- Open the project Pi assistant workspace: `just agent` or `just a`

## Architecture map

- Bot runtime: `src/bot/**`
- Repository CLI and deterministic operations: `src/cli.ts`, `src/bot/operations/**`
- Pi SDK gateway and lanes: `src/bot/ai/gateway.ts`
- Prompt-role helpers: `src/bot/ai/prompt.ts`, `src/bot/ai/reply-composer.ts`
- Telegram adapters: `src/bot/telegram/**`
- Agent workspace: `agent/.pi/**`

See [docs/agent-architecture.md](docs/agent-architecture.md) for the Pi workspace, assistant/composer/maintainer lanes, and tool loading rules. See [docs/principles.md](docs/principles.md) for project-wide engineering principles.

## Pi workspace rules

- Runtime Pi resources live under `agent/.pi/`.
- Do not commit `agent/.pi/auth.json`, `agent/.pi/models.json`, `agent/.pi/sessions/`, or `agent/.pi/npm/`.
- Main assistant sessions load `agent/.pi/AGENTS.md`, Pi tools, and skills.
- Composer/writer and maintainer sessions should stay narrow; they should not load full AGENTS context unless intentionally changed.
- Use `agent/.pi/extensions/defect-bot-tools` for deterministic bot actions instead of asking the model to shell out directly.

## Coding rules

- Prefer explicit deterministic interfaces over prompt protocols for durable state.
- Keep Telegram runtime concerns separate from repository state changes.
- Keep user-visible reply publication in runtime code; do not let tools independently duplicate the current-turn reply.
- Treat `allowed`, `trusted`, and `admin` access boundaries as security boundaries.
- If changing Pi session/resource loading, check startup latency and `/new` session behavior.

## Testing expectations

For code changes, run at least `npm run check` and the focused tests. For changes touching Pi gateway, prompts, Telegram output, or conversation flow, run relevant tests such as:

```bash
npm test -- tests/gateway-tools.test.ts tests/pi-config.test.ts
npm test -- tests/conversation-controller.test.ts tests/telegram-output.test.ts
```

Run the full `npm test` before handing off broad architecture changes.
