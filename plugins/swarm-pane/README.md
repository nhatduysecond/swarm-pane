# swarm-pane

A pane that sits beside the transcript and answers one question while Claude Code
works: who is running, on what, and with which model.

Every subagent gets a row with the task it was given, the model and reasoning
effort it was dispatched with, how long it has been running, and what it has spent
so far in tokens and tool calls. The session's task list sits above it, each line
marked done, running or waiting — finished work dimmed, the line in hand the
brightest in the section — and a running line names the agent that owns it;
finished work collapses to one counted line so the open work fills the section.
Agents that finish drop to a short history so you can still see what they cost.

The token figure is the prompt of the agent's latest request plus everything it
has written. A step's prompt replaces the one before it rather than being added to
it: the cached context is one prompt sent again, not new work, and adding each
step's would read a long agent as millions. Measured against the engine's own
figure over five real runs, this lands within a percent of it.

A second tab, `log`, opens beside it and shows the first line of each of the last
messages of the agent the stop button aims at — the flagged one, else the one
running longest. `t` brings that tab forward and pins it to that agent, which it
then keeps showing after that agent has finished. Three keys work while the pane
holds the keyboard (`ctrl+x tab`, or a click): `s` stops the agent it names, `t`
opens the log tab, `c` copies the summary.

The session's own `TodoWrite` fills the task list and always wins. A plan made
before the pane opened is read back from the session's own transcript when it
starts, so a pane opened — or a plugin reloaded — mid-session still shows it.

A session with no task list of its own falls back to the repository's own plan:
the newest dated folder under `plans/` that holds one — three are looked at, so a
folder of reports or a bare brief does not silence the section — whose `- [x]` and
`- [ ]` rows become the list,
reread every ten seconds while the pane is open, with `plan` beside the heading
to say where it came from. A build whose task tool is absent still shows the work
the plan names.

With neither — no task tool, no plan file — a small model (`haiku`) reads the list
out of the conversation at the end of each of your turns, at most once a minute,
and the heading says `read` so an inferred list is never mistaken for one the
session wrote. It is the last source tried, never the first. The `tasks` field
picks between `auto` (the three sources above), `plan` (never asks a model) and
`off` (the session's own list only). A subagent that
plans its own work is drawn only while the session has no plan of its own, with
the agent's label beside the heading so it is clear whose list it is.

## Install

```
/plugin marketplace add <owner>/<repo>
/plugin install swarm-pane@<marketplace>
```

Then `/swarm` opens the pane. It docks to the right of the transcript on a
fullscreen terminal 110 columns or wider; narrower, it opens above the prompt and
drops its optional columns to fit. A line at the top tells you which of the two
conditions a dock is still missing.

Where a pane's seat comes from is not the plugin's to decide: `placement` is
read-only, and only the fullscreen layout keeps a column beside the transcript —
the main screen scrolls, so there is nowhere to the right to keep. So the first
time the pane opens on the main screen it runs `/tui fullscreen` for you, which
restarts and resumes the session and saves the choice to your own preferences:
every session after that opens docked, and the ask is never made again, even if
the renderer failed to start. Set `dock` to `off` to keep your own renderer and
read the pane above the prompt.

## Settings

Five fields, all optional, each with a default that needs no setting:
`tasks`, `dock`, `heading`, `headingText` and `background`, described below and
in the manifest.

```
/plugin configure swarm-pane            # in Claude Code, a screen per field
claude plugin configure swarm-pane@<marketplace>   # shows them and which are set
echo '{"heading":"claude"}' | claude plugin configure swarm-pane@<marketplace> --values-stdin
```

A change reloads the hooks module with the new values; the pane redraws with them.

## Colours

Each section heading is a filled bar, in `subtle` by default: a theme key, so it
follows your light or dark theme rather than a colour picked for one of them.
`heading` takes another theme key (`inactive`, `claude`, `success`, ...), a hex
colour, or `off` for the plain heading with a rule after it. `headingText`
colours the heading's own letters, a theme key or a hex; empty takes
`inverseText` over a bar, and your terminal's foreground once the bar is `off`.
`background` fills
the whole pane the same way and is empty by default, because a fill is a fixed
colour over the column and takes the terminal's own transparency with it. Everything else is
coloured text on your terminal's background: one accent per agent, shared by its
task row and its block, green for finished work, amber for a warning.

## Risk zones

If the open project's `CLAUDE.md` has a section whose heading mentions risk zones,
the pane reads it. Each bullet shaped `- Label: term, term` becomes one zone. The heading is
matched in English and in Vietnamese (`Vùng rủi ro`), so a bilingual project
needs no second section. Task
rows touching a zone get a label, and an agent sent into one on `haiku` or at
`effort: low` raises a warning the moment it spawns, while there is still time to
stop it. The warning is drawn beside the running list, under a bar, rather than in
a section of its own.

`CLAUDE.md` and, when the session has no task list, the newest folder under
`plans/` are the only files this plugin reads. Under `tasks: auto` it also sends
the last few messages of your own session to the same API the session already
uses, to read the task list out of them; `tasks: plan` or `off` sends nothing. The rest of what it draws comes
from your own session: the events it hooks, the session's own messages, read once
at startup for a plan already made, and — for the log tab — the messages of the
subagent that tab follows. Nothing
is sent anywhere, and what the pane keeps lives in the session's own plugin state.

## What the hooks do

Eleven handlers, listed with what each one reads and whether it changes anything.
None of them rewrites a prompt, a tool call, a setting, an instruction or a tool
description, and none denies anything. Two write something of their own, both on a
press: the stop button ends the agent's turn, and the warning raises a toast.

| Hook | What it does | Changes |
|---|---|---|
| `session.start` | Registers the `/swarm` command, opens both tabs, reads the project's `CLAUDE.md` for risk zones, the session's own transcript for a plan already made, and the newest `plans/` folder when there is none | none; passes through |
| `session.end` (`clear`) | Empties the agents, the tokens and the task list when a `/clear` ends the conversation. The engine raises no `session.start` for what follows a clear, so this is the only place the pane learns of it | none; passes through |
| `command.run` (`swarm`) | Answers the plugin's own `/swarm` command by reopening the pane | answers only its own command; no other command reaches it |
| `tool.call` (`Agent`) | Reads the description, subagent type, model and effort of a subagent about to start, and raises the toast when it breaks the rule | none; the call runs as written, and a failure of this bookkeeping is swallowed before it |
| `agent.spawn` | Keeps the started agent's id so the agent's own tool calls can be counted against it | none; the spawn is passed through untouched and the engine's result is returned as received |
| `tool.call` (all) | Counts tool calls per agent, and reads `TodoWrite` input to mirror the task list | none; every call is passed through |
| `turn.start` | Keeps the turn's clock, and the id of a subagent's turn, which the stop button ends | none; passes through |
| `turn.complete` | Ends a subagent's run, which is what moves it to DONE, and at the end of your own turn asks a small model for the task list when nothing else wrote one | none; passes through. The model call is the plugin's own, tool-less, and only under `tasks: auto` |
| `turn.step` | Reads what each of an agent's model requests cost, to keep its token figure | none; the stream is passed through chunk for chunk |
| `ui.render` (`swarm`) | Draws the pane | draws its own pane; the stop button ends that agent's turn |
| `ui.render` (`log`) | Draws the log tab from the followed agent's own messages | draws its own pane only |

Bookkeeping failures are swallowed on purpose: a pane one beat out of date is
better than a blocked tool call.

Besides the hooks, a one-second clock asks the engine for its own list of the
session's agents and folds it into what the events recorded. Events are quicker,
and they are what carries tokens and tool counts, but they see only what the
Agent tool spawned in a loop this plugin hooks: a forked skill, another plugin's
spawn, a resumed run, or a spawn whose bookkeeping was lost to a reload would
otherwise never reach the pane. The reconcile only adds an agent and marks a
finished one done; it never removes a row, because the engine drops an agent from
its list a while after it ends and the row holds that agent's tokens. A
workflow's agents are in no list, so they are still counted from their calls
alone.

## Notes

The elapsed bar is relative to the longest-running live agent, not progress — no
such number exists. The model and effort of an agent are never dropped, however
narrow the pane gets; the optional columns go first — the zone chip under 52
columns, the owning agent under 38, and the token and tool figures under 46, where
model and effort take that line instead. A call that names no model or effort is
drawn, and judged, as `inherit` and `medium`.

## Licence

MIT.
