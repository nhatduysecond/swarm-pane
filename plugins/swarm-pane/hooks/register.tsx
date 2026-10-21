import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import type { Agent, Todo, Zone } from '../types'

const PANE = 'swarm'

const agents = atom({ plugin: 'swarm-pane', key: 'agents' } as const, [])
const todos = atom({ plugin: 'swarm-pane', key: 'todos' } as const, [])
const tick = atom({ plugin: 'swarm-pane', key: 'tick' } as const, 0)
const zones = atom({ plugin: 'swarm-pane', key: 'zones' } as const, [])

/** One colour per agent, shared by its task row and its agent block. */
const INK = ['#ff2d87', '#4ddbd0', '#a78bfa', '#ffb02e']
const WARN = '#ffb02e'
const OK = '#35d07f'

/**
 * Risk zones are read from the open project's CLAUDE.md, never hardcoded.
 *
 * It takes the section whose heading says "risk zone", and reads each bullet
 * shaped `- Label: term, term` as one zone. A project that declares none gets
 * no chips and no warnings; the pane still runs.
 */
export const parseZones = (md: string): Zone[] => {
  const lines = md.split('\n')
  const head = lines.findIndex(l => /^#{1,6} .*(risk zone|vùng rủi ro)/i.test(l))
  if (head < 0) return []

  const zones: Zone[] = []
  for (const line of lines.slice(head + 1)) {
    if (/^#{1,6} /.test(line)) break
    const bullet = /^\s*[-*]\s+(.+)$/.exec(line)
    const body = bullet?.[1]
    if (!body) continue
    const [label, ...rest] = body.split(':')
    if (rest.length === 0 || !label) continue
    const name = (label.replace(/[*`_]/g, '').trim().split(/\s+/)[0] ?? '')
      .toLowerCase()
      .slice(0, 7)
    const terms = rest
      .join(':')
      .split(/[,;·]/)
      .map(t => t.replace(/[`*_[\]()]/g, '').trim().toLowerCase())
      .filter(t => t.length >= 3 && t.length <= 24)
    if (name) zones.push({ label: name, terms: [name, ...terms] })
  }
  return zones
}

export const zoneOf = (zones: readonly Zone[], text: string): string | undefined => {
  const hay = text.toLowerCase()
  return zones.find(z => z.terms.some(t => hay.includes(t)))?.label
}

/** House rule: risky work does not go to a weak model or a low effort. */
export const offRule = (zones: readonly Zone[], a: Agent): string | undefined => {
  const hit = zoneOf(zones, a.desc)
  if (!hit) return undefined
  if (a.model === 'haiku') return `${a.label} works on ${hit} with haiku`
  if (a.effort === 'low') return `${a.label} works on ${hit} at effort low`
  return undefined
}

export const fmt = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Grey bar: elapsed against the longest-running live agent. Not progress. */
export const bar = (ms: number, longest: number, w = 8): string => {
  const n = longest > 0 ? Math.round((ms / longest) * w) : 0
  return '█'.repeat(Math.min(w, n)) + '░'.repeat(Math.max(0, w - n))
}

const live = (list: readonly Agent[]) => list.filter(a => a.endedAt === undefined)

/** The pane's bookkeeping must never break a real tool call. */
const quiet = async (work: Promise<unknown>): Promise<void> => {
  try {
    await work
  } catch {
    // a pane one beat out of date beats blocking the user's command
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'swarm', description: 'Open the subagent pane' })
    void $.ui.open({ id: PANE, title: 'swarm', columns: 56 })

    try {
      const md = await $.fs.read('CLAUDE.md')
      await update($, zones, () => parseZones(md))
    } catch {
      // No CLAUDE.md in this project: no chips, no warnings.
    }

    // The clock ticks only while an agent runs, to avoid pointless redraws.
    $.clock.every(1000, async () => {
      const list = await read($, agents)
      if (live(list).length > 0) await update($, tick, n => n + 1)
    })

    return next(e)
  })

  on('command.run', { command: 'swarm' }, async $ => {
    await $.ui.open({ id: PANE, title: 'swarm', columns: 56 })
    return { text: 'Swarm pane opened.' }
  })

  // The Agent call already carries description/model/effort; read it before the run.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const input = e as unknown as {
      description?: string
      subagent_type?: string
      model?: string
      effort?: string
    }
    const now = await $.clock.now()
    const one: Agent = {
      label: '',
      callId: e.tool_use_id,
      desc: input.description ?? 'agent',
      type: input.subagent_type ?? 'general-purpose',
      model: input.model ?? 'inherit',
      effort: input.effort ?? 'medium',
      startedAt: now,
      tools: 0,
    }
    await quiet(
      update($, agents, list => [
        ...list,
        { ...one, label: `a-${String(list.length + 1).padStart(2, '0')}` },
      ]),
    )

    const known = await read($, zones)
    const warn = offRule(known, one)
    if (warn) $.ui.toast(`⚠ ${warn}`)

    const ran = await next(e)

    // A background agent's call returns the moment it launches, so this is not
    // the end of its run: `turn.complete` carrying its agentId is. Only an agent
    // that never reported an agentId (a remote or workflow one) is closed here.
    const done = await $.clock.now()
    await quiet(
      update($, agents, list =>
        list.map(a =>
          a.callId === one.callId && a.id === undefined ? { ...a, endedAt: done } : a,
        ),
      ),
    )

    return ran
  })

  // The real agentId appears only here; keep it to count the child's tool calls.
  on('agent.spawn', async ($, e, next) => {
    const ran = await next(e)
    await quiet(
      update($, agents, list =>
        list.map(a => (a.callId === e.tool_use_id ? { ...a, id: ran.agentId } : a)),
      ),
    )
    return ran
  })

  // A subagent answers with its own turn.complete; that is when its run ends.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const done = await $.clock.now()
      await quiet(
        update($, agents, list =>
          list.map(a => (a.id === e.agentId && a.endedAt === undefined ? { ...a, endedAt: done } : a)),
        ),
      )
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId) {
      await quiet(
        update($, agents, list =>
          list.map(a => (a.id === e.agentId ? { ...a, tools: a.tools + 1 } : a)),
        ),
      )
    }
    if (e.tool === 'TodoWrite') {
      const list = (e as unknown as { todos?: Todo[] }).todos
      if (Array.isArray(list)) {
        await quiet(
          update($, todos, () =>
            list.map(t => ({ content: t.content, status: t.status })),
          ),
        )
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, agents)
    const tasks = await read($, todos)
    await read($, tick)
    const now = await $.clock.now()

    // The pane is resizable, so every column follows the width the engine reports.
    const w = e.props.bodyColumns
    const room = e.props.scroll?.bodyRows ?? 24
    const showChip = w >= 52
    const showWho = w >= 38
    const stack = w < 46
    const inline = e.props.placement === 'inline'
    const tight = inline || room < 18

    const running = live(list)
    const finished = list.filter(a => a.endedAt !== undefined)
    const doneTasks = tasks.filter(t => t.status === 'completed')
    const open = tasks.filter(t => t.status !== 'completed')
    const shown = tight ? open.slice(0, Math.max(2, room - 9)) : tasks
    const longest = Math.max(1, ...running.map(a => now - a.startedAt))
    const ink = (a: Agent) => INK[list.indexOf(a) % INK.length]
    const known = await read($, zones)
    const warns = running.map(a => offRule(known, a)).filter(Boolean) as string[]

    // A running agent is matched to its task row by description.
    const owner = (content: string) =>
      running.find(a => content.includes(a.desc) || a.desc.includes(content))

    const row = (
      mark: string,
      markInk: string | undefined,
      text: string,
      chip?: string,
      who?: string,
      whoInk?: string,
    ) => (
      <Box>
        <Text color={markInk} dimColor={!markInk}>{mark} </Text>
        <Box flexGrow={1} minWidth={0}>
          <Text wrap="truncate-end" dimColor={!markInk}>{text}</Text>
        </Box>
        {showChip && (
          <Box width={9} justifyContent="center">
            {chip ? <Text color={WARN}>{chip}</Text> : <Text> </Text>}
          </Box>
        )}
        {showWho && (
          <Box width={5} justifyContent="flex-end">
            {who ? <Text color={whoInk}>{who}</Text> : <Text> </Text>}
          </Box>
        )}
      </Box>
    )

    return (
      <Box flexDirection="column">
        {inline && (
          <Text dimColor>
            ⤷ dock needs: fullscreen {e.viewport?.isFullscreen ? '✓' : '✗'} ·{' '}
            {e.viewport?.columns ?? 0}/110 cols
          </Text>
        )}
        <Box>
          <Box flexGrow={1}>
            <Text dimColor>{running.length} agent{w >= 34 ? ' running' : ''}</Text>
          </Box>
          <Text dimColor>{doneTasks.length}/{tasks.length}{w >= 34 ? ' tasks' : ''}</Text>
        </Box>

        {tasks.length > 0 && <Text bold>{'\n'}TASKS</Text>}
        {tight && doneTasks.length > 0 && (
          <Text dimColor>[✓] +{doneTasks.length} done earlier</Text>
        )}
        {shown.map(t => {
          const a = t.status === 'in_progress' ? owner(t.content) : undefined
          const mark =
            t.status === 'completed' ? '[✓]' : t.status === 'in_progress' ? '[◐]' : '[ ]'
          const markInk =
            t.status === 'completed'
              ? OK
              : t.status === 'in_progress'
                ? (a ? ink(a) : INK[0])
                : undefined
          return row(mark, markInk, t.content, zoneOf(known, t.content), a?.label, a ? ink(a) : undefined)
        })}

        {running.length > 0 && <Text bold>{'\n'}RUNNING</Text>}
        {running.map(a => (
          <Box flexDirection="column">
            <Box>
              <Text color={ink(a)} bold>{a.label} </Text>
              <Box flexGrow={1} minWidth={0}><Text wrap="truncate-end">{a.desc}</Text></Box>
              {!stack && <Text dimColor>{a.model} · {a.effort}</Text>}
            </Box>
            <Box paddingLeft={stack ? 0 : 5}>
              <Box flexGrow={1}>
                <Text dimColor>{bar(now - a.startedAt, longest, w < 40 ? 5 : 8)} </Text>
                <Text color={ink(a)}>{fmt(now - a.startedAt)}</Text>
              </Box>
              <Text dimColor>
                {stack ? `${a.model} · ${a.effort}` : `${a.type} · ${a.tools} tools`}
              </Text>
            </Box>
          </Box>
        ))}

        {warns.map(wn => (
          <Text color={WARN} wrap="truncate-end">⚠ {wn}</Text>
        ))}

        {finished.length > 0 && <Text bold>{'\n'}DONE ({finished.length})</Text>}
        {finished.slice(tight ? -1 : -2).map(a => (
          <Box>
            <Text color={OK}>{a.label} </Text>
            <Box flexGrow={1} minWidth={0}><Text dimColor wrap="truncate-end">{a.desc}</Text></Box>
            <Text dimColor>
              {a.model} · {a.effort}{showChip ? ` · ${fmt((a.endedAt ?? 0) - a.startedAt)}` : ''}
            </Text>
          </Box>
        ))}

        {list.length === 0 && tasks.length === 0 && (
          <Text dimColor>No agents or tasks in this session yet.</Text>
        )}
      </Box>
    )
  })
}
