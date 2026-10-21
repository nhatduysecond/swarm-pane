# swarm-pane

A pane that sits beside the transcript and answers one question while Claude Code
works: who is running, on what, and with which model.

Every subagent gets a row with the task it was given, the model and reasoning
effort it was dispatched with, how long it has been running, and what it has spent
so far in tokens and tool calls. The session's task list sits above it, each line
marked done, running or waiting, and a running line names the agent that owns it;
finished work collapses to one counted line so the open work fills the section.
Agents that finish drop to a short history so you can still see what they cost.

The token figure is what the agent's own requests paid for — uncached input, cache
writes and output, summed over its steps. Tokens the prompt cache served are left
out: the same prompt read again is not more work, and counting it would dwarf
everything else in the row.

A second tab, `log`, opens beside it and shows the last messages of the agent the
stop button aims at; `t` brings that tab forward and pins it to that agent.

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

That file is the only thing this plugin reads. Nothing is sent anywhere: the pane
draws from the events of your own session, and what it keeps lives in the session's
own plugin state.

## What the hooks do

Seven hooks, listed with what each one reads and whether it changes anything. None
of them rewrites a prompt, a tool call, a setting, an instruction or a tool
description, and none denies anything.

| Hook | What it does | Changes |
|---|---|---|
| `session.start` | Registers the `/swarm` command, opens the pane, reads the project's `CLAUDE.md` once for risk zones | none; passes through |
| `command.run` (`swarm`) | Answers the plugin's own `/swarm` command by reopening the pane | answers only its own command; no other command reaches it |
| `tool.call` (`Agent`) | Reads the description, subagent type, model and effort of a subagent about to start, then times it until the call returns | none; the call runs as written |
| `agent.spawn` | Keeps the started agent's id so the agent's own tool calls can be counted against it | none; the spawn is passed through untouched and the engine's result is returned as received |
| `tool.call` (all) | Counts tool calls per agent, and reads `TodoWrite` input to mirror the task list | none; every call is passed through |
| `turn.step` | Reads what each of an agent's model requests cost, to keep its token figure | none; the stream is passed through chunk for chunk |
| `ui.render` (`Pane`) | Draws the pane and, on `t`, the `log` tab from the agent's own messages | draws its own panes only |

Bookkeeping failures are swallowed on purpose: a pane one beat out of date is
better than a blocked tool call.

## Notes

The elapsed bar is relative to the longest-running live agent, not progress — no
such number exists. The model and effort of an agent are never dropped, however
narrow the pane gets; the optional columns go first.

## Licence

MIT.
