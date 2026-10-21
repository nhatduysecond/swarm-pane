# swarm-pane

A pane that sits beside the transcript and answers one question while Claude Code
works: who is running, on what, and with which model.

Every subagent gets a row with the task it was given, the model and reasoning
effort it was dispatched with, how long it has been running, and what it has spent
so far in tokens and tool calls. The session's task list sits above it, each line
marked done, running or waiting, and a running line names the agent that owns it;
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

The session's own `TodoWrite` fills the task list and always wins. A subagent that
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

## Risk zones

If the open project's `CLAUDE.md` has a section whose heading mentions risk zones,
the pane reads it. Each bullet shaped `- Label: term, term` becomes one zone. The heading is
matched in English and in Vietnamese (`Vùng rủi ro`), so a bilingual project
needs no second section. Task
rows touching a zone get a label, and an agent sent into one on `haiku` or at
`effort: low` raises a warning the moment it spawns, while there is still time to
stop it. The warning is drawn beside the running list, under a bar, rather than in
a section of its own.

`CLAUDE.md` is the only file this plugin reads. The rest of what it draws comes
from your own session: the events it hooks, and — for the log tab alone — the
messages of the subagent that tab follows, read back through the session. Nothing
is sent anywhere, and what the pane keeps lives in the session's own plugin state.

## What the hooks do

Nine handlers, listed with what each one reads and whether it changes anything.
None of them rewrites a prompt, a tool call, a setting, an instruction or a tool
description, and none denies anything. Two write something of their own, both on a
press: the stop button ends the agent's turn, and the warning raises a toast.

| Hook | What it does | Changes |
|---|---|---|
| `session.start` | Registers the `/swarm` command, opens the pane, reads the project's `CLAUDE.md` once for risk zones | none; passes through |
| `command.run` (`swarm`) | Answers the plugin's own `/swarm` command by reopening the pane | answers only its own command; no other command reaches it |
| `tool.call` (`Agent`) | Reads the description, subagent type, model and effort of a subagent about to start, and raises the toast when it breaks the rule | none; the call runs as written, and a failure of this bookkeeping is swallowed before it |
| `agent.spawn` | Keeps the started agent's id so the agent's own tool calls can be counted against it | none; the spawn is passed through untouched and the engine's result is returned as received |
| `tool.call` (all) | Counts tool calls per agent, and reads `TodoWrite` input to mirror the task list | none; every call is passed through |
| `turn.start` | Keeps the turn's clock, and the id of a subagent's turn, which the stop button ends | none; passes through |
| `turn.complete` | Ends a subagent's run, which is what moves it to DONE | none; passes through |
| `turn.step` | Reads what each of an agent's model requests cost, to keep its token figure | none; the stream is passed through chunk for chunk |
| `ui.render` (`swarm`) | Draws the pane | draws its own pane; the stop button ends that agent's turn |
| `ui.render` (`log`) | Draws the log tab from the followed agent's own messages | draws its own pane only |

Bookkeeping failures are swallowed on purpose: a pane one beat out of date is
better than a blocked tool call.

## Notes

The elapsed bar is relative to the longest-running live agent, not progress — no
such number exists. The model and effort of an agent are never dropped, however
narrow the pane gets; the optional columns go first — the zone chip under 52
columns, the owning agent under 38, and the token and tool figures under 46, where
model and effort take that line instead. A call that names no model or effort is
drawn, and judged, as `inherit` and `medium`.

## Licence

MIT.
