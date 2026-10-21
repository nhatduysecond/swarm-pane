# swarm-pane

A pane that sits beside the transcript and answers one question while Claude Code
works: who is running, on what, and with which model.

Every subagent gets a row with the task it was given, the model and reasoning
effort it was dispatched with, how long it has been running, and how many tools it
has called. The session's task list sits above it, each line marked done, running
or waiting, and a running line names the agent that owns it. Agents that finish
drop to a short history so you can still see what they cost.

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
the pane reads it. Each bullet shaped `- Label: term, term` becomes one zone. Task
rows touching a zone get a label, and an agent sent into one on `haiku` or at
`effort: low` raises a warning the moment it spawns, while there is still time to
stop it.

That file is the only thing this plugin reads. Nothing is sent anywhere: the pane
draws from the events of your own session, and what it keeps lives in the session's
own plugin state.

## Notes

The elapsed bar is relative to the longest-running live agent, not progress — no
such number exists. The model and effort of an agent are never dropped, however
narrow the pane gets; the optional columns go first.

## Licence

MIT.
