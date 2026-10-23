# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Claude Code marketplace (`.claude-plugin/marketplace.json`) holding one plugin, `plugins/swarm-pane`: a mod pane (`/swarm`) that shows running subagents (model, effort, elapsed, tokens, tool calls) beside the session's task list, plus a `log` tab for one agent's messages. There is no package.json, bundler or node_modules. The engine loads `hooks/register.tsx` directly (via `hooks/hooks.json`) and supplies the `claude-code` module.

## Risk zones

- Passthrough: tool.call, agent.spawn, turn.step, next(e), quiet
- Writes: stop button, tui fullscreen, toast, asked-for-the-dock
- Outbound: readByModel, haiku, session messages

## Test commands

Run from `plugins/swarm-pane/`:

```
claude plugin test                # runs every *.test.ts(x); exits 1 on failure
claude plugin validate .          # checks plugin.json / README install line
```

`claude plugin test` has no filter flag. To run one test, use `test.only` in `hooks/register.test.tsx` for that run and take it out afterwards. Tests import their kit from `claude-code/testing`.

`tsconfig.json` extends `.claude-plugin/types/tsconfig.json`. The engine generates that folder when it loads the plugin, and it is gitignored, so type info only appears after the plugin has been loaded once.

## Architecture

All logic lives in `hooks/register.tsx`, and every test lives in `hooks/register.test.tsx`.

- **State** is a set of `atom`s keyed under `'swarm-pane'` (`agents`, `todos`, `zones`, `logFor`, `todoFrom`, `planAt`, …). Their types are declared in `types/index.d.ts` by augmenting `PluginState` in `claude-code`, so a new atom needs a field there too.
- **Pure helpers are exported** (`parseZones`, `zoneOf`, `offRule`, `parsePlan`, `merge`, `aim`, `spend`, `tokOf`, `wrap`, `bar`, `fmt`, …) so tests can call them directly. Render tests drive `ui.render` with a `PANE`-shaped request.
- **`register(on, options)`** wires the handlers. `options` holds the `userConfig` fields from `.claude-plugin/plugin.json` (`tasks`, `dock`, `heading`, `headingText`, `background`).
- **Agent tracking** has two inputs. Hook events (`tool.call` on `Agent`, `agent.spawn`, `tool.call`, `turn.step`, `turn.complete`) carry tokens and tool counts. A one-second ticker (`sync`) reconciles against the engine's own agent list to pick up spawns the hooks missed. `merge` may add an agent or mark one done, but it never removes a row, because the row holds that agent's tokens.
- **Token figure** = the latest request's whole prompt (`ctx`, which replaces the previous one) plus the sum of output (`out`). Don't add up `ctx` across steps.
- **Task list sources**, in priority order: the session's own `TodoWrite` (always wins, and is also recovered from the transcript at `session.start`), then the newest dated folder under `plans/` with `- [x]`/`- [ ]` rows (up to three folders are checked, reread every 10s), then a `haiku` read of the conversation at end of turn (at most once a minute, only under `tasks: auto`). `todoFrom` records which source wrote the list (`''`, `'plan'`, `'read'`, or an agentId), and the heading labels it.
- **Risk zones** come from the open project's `CLAUDE.md`: a heading that mentions risk zones (English or `Vùng rủi ro`), with bullets shaped `- Label: term, term`. A spawn on `haiku` or `effort: low` into a zone raises a toast (`offRule`). Zones are never hardcoded.
- **Bookkeeping failures are swallowed on purpose** (`quiet`, try/catch around reads). A hook must never block or alter a tool call, prompt or spawn. Every handler passes through to `next`.

## Conventions

- `plugins/swarm-pane/README.md` documents behaviour in detail, including the hook table, the handler count, the narrow-width column-drop thresholds and the files read. Past commits fixed drift between it and the code, so update it whenever behaviour changes.
- Bump `version` in `.claude-plugin/plugin.json` for a release.
- Commit subjects are conventional (`feat:`/`fix:`/`docs:`) followed by a lowercase plain-English sentence describing the effect, e.g. `fix: a clear empties the pane with the conversation`.
