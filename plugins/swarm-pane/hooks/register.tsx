import { atom, read, update } from 'claude-code'
import type {
  AgentInfo,
  EngineInterface,
  ModelUsage,
  Register,
  SessionMessage,
  Timer,
} from 'claude-code'

import type { Agent, Todo, Zone } from '../types'

const PANE = 'swarm'
const LOG = 'log'
/** Store key: the renderer has been asked for once, whatever came of it. */
const DOCKED = 'asked-for-the-dock'
/** What `todoFrom` holds when the list was read from a plan file. */
const PLAN = 'plan'
/** What it holds when a small model read the list out of the conversation. */
const READ = 'read'

const agents = atom({ plugin: 'swarm-pane', key: 'agents' } as const, [])
const todos = atom({ plugin: 'swarm-pane', key: 'todos' } as const, [])
const tick = atom({ plugin: 'swarm-pane', key: 'tick' } as const, 0)
const zones = atom({ plugin: 'swarm-pane', key: 'zones' } as const, [])
const turnAt = atom({ plugin: 'swarm-pane', key: 'turnAt' } as const, 0)
const logFor = atom({ plugin: 'swarm-pane', key: 'logFor' } as const, '')
const todoFrom = atom({ plugin: 'swarm-pane', key: 'todoFrom' } as const, '')
const planAt = atom({ plugin: 'swarm-pane', key: 'planAt' } as const, 0)

/** One colour per agent, shared by its task row and its agent block. */
/** The one-second clock behind every elapsed time the pane draws. */
let ticker: Timer | undefined
const INK = ['#ff2d87', '#4ddbd0', '#a78bfa', '#ffb02e']
const WARN = '#ffb02e'
/**
 * ASCII, and every mark the same width.
 *
 * A tick or a half-circle is an ambiguous-width character: one terminal draws
 * it in one cell, another in two, and rows stop lining up where the font
 * decides. Colour carries the state; the glyph only has to hold its column.
 */
const MARK = { completed: '[x]', in_progress: '[>]', pending: '[ ]' } as const
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

/** How old the plan on disk may be before the pane reads it again. */
const PLAN_EVERY = 10_000

/**
 * The checkbox lists of a plan file: `- [x]` done, `- [ ] ` waiting, anything
 * else between the brackets in progress.
 */
export const parsePlan = (md: string): Todo[] => {
  const found: Todo[] = []
  for (const line of md.split('\n')) {
    const row = /^\s*[-*]\s*\[(.)\]\s+(.+?)\s*$/.exec(line)
    if (!row) continue
    const mark = (row[1] ?? '').toLowerCase()
    const content = (row[2] ?? '').replace(/[*`]/g, '').trim()
    if (content === '') continue
    found.push({
      content,
      status: mark === 'x' ? 'completed' : mark === ' ' ? 'pending' : 'in_progress',
    })
  }
  return found
}

/**
 * The newest plan folder's checkboxes, in file order.
 *
 * A build with no task list of its own leaves the section empty, while the plan
 * the work follows sits in the repository; `plans/{date}-{slug}/` is where this
 * project's own convention puts it, newest by name.
 */
const planOnDisk = async ($: EngineInterface): Promise<Todo[] | undefined> => {
  // Dated by the convention, so the name orders them. Taking the last name of
  // any kind would pick `reports/` over every plan in the folder.
  const dirs = (await $.fs.list('plans')).filter(d => d.kind === 'dir' && /^\d{6}/.test(d.name))
  // The newest folder may hold only reports or a brief. Three back is far
  // enough to find the plan in hand, and near enough not to show a stale one.
  const recent = [...dirs].sort((a, b) => (a.name < b.name ? 1 : -1)).slice(0, 3)

  for (const dir of recent) {
    const here = `plans/${dir.name}`
    const files = (await $.fs.list(here))
      .filter(f => f.kind === 'file' && f.name.endsWith('.md'))
      .sort((a, b) => (a.name < b.name ? -1 : 1))

    const found: Todo[] = []
    for (const f of files) {
      found.push(...parsePlan(await $.fs.read(`${here}/${f.name}`)))
      if (found.length >= 30) break
    }
    if (found.length > 0) return found.slice(0, 30)
  }
  return undefined
}

/** Reads the plan on disk into the section, at most once every ten seconds. */
const readPlan = async ($: EngineInterface, now: number): Promise<void> => {
  // The clock lives in the session's own state: two sessions in one process
  // must not starve each other's reread.
  if (now - (await read($, planAt)) < PLAN_EVERY) return
  await update($, planAt, () => now)
  const found = await planOnDisk($)
  if (found === undefined) return
  await update($, todos, () => found)
  await update($, todoFrom, () => PLAN)
}

/** How long a read list stands before a small model is asked again. */
const READ_EVERY = 60_000

const ASK = [
  'Read the conversation above and answer with the task list it is working',
  'through, as checkbox rows and nothing else: `- [x] done`, `- [~] in hand`,',
  '`- [ ] still to do`. At most 8 rows, each under 60 characters, in the',
  'language of the conversation. No heading, no prose, no explanation. Answer',
  'with nothing at all if the conversation names no tasks.',
].join(' ')

/**
 * The task list a small model reads out of the conversation.
 *
 * The last resort: a build with no task tool, and a repository with no plan
 * file, still shows what the session is working through. It costs one small
 * completion a turn, so it is the third source tried, never the first.
 */
const readByModel = async ($: EngineInterface, said: readonly SessionMessage[]) => {
  const recent = said
    .slice(-12)
    .map(m => `${m.role}: ${(m.text || m.toolUses.map(u => u.tool).join(', ')).slice(0, 400)}`)
    .join('\n')
  if (recent.trim() === '') return undefined

  const reply = await $.model.complete({
    model: 'haiku',
    prompt: `${recent}\n\n---\n${ASK}`,
    maxTokens: 400,
  })
  if (!reply.isAnswered) return undefined
  const found = parsePlan(reply.text)
  return found.length > 0 ? found : undefined
}

/** A TodoWrite's input, as the pane keeps it. */
export const asTodos = (input: unknown): Todo[] | undefined => {
  const list = (input as { todos?: unknown }).todos
  if (!Array.isArray(list)) return undefined
  return list.map(t => ({
    content: String((t as Todo).content ?? ''),
    status: String((t as Todo).status ?? ''),
  }))
}

/**
 * The newest plan in a transcript, or nothing.
 *
 * The pane sees a TodoWrite only while it is loaded, so a session that planned
 * before it opened — or before the plugin was reloaded — would show an empty
 * section with a full plan sitting in its own transcript.
 */
export const planIn = (said: readonly { toolUses?: readonly { tool: string; input: unknown }[] }[]) => {
  for (let i = said.length - 1; i >= 0; i--) {
    const uses = said[i]?.toolUses ?? []
    for (let u = uses.length - 1; u >= 0; u--) {
      if (uses[u]?.tool !== 'TodoWrite') continue
      const found = asTodos(uses[u]?.input)
      if (found) return found
    }
  }
  return undefined
}

export const fmt = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/**
 * One step's usage folded into the agent: the prompt replaces what the last
 * request held, and only what the agent wrote is added to what it wrote before.
 */
export const spend = (a: Agent, used: ModelUsage): Agent => ({
  ...a,
  ctx: used.input_tokens + used.cache_read_input_tokens + used.cache_creation_input_tokens,
  out: (Number.isFinite(a.out) ? a.out : 0) + used.output_tokens,
})

/**
 * What the agent has cost: the prompt of its latest request plus everything it
 * has written. Measured against the engine's own figure over five real runs it
 * lands within a percent, where summing each step's prompt overstates it by two
 * to fifty times — the cached context is one prompt, sent again, not new work.
 *
 * An agent the pane recorded before it counted tokens has neither; it reads zero.
 */
export const tokOf = (a: Partial<Pick<Agent, 'ctx' | 'out'>>): number =>
  (Number.isFinite(a.ctx) ? (a.ctx as number) : 0) +
  (Number.isFinite(a.out) ? (a.out as number) : 0)

export const ktok = (n: number): string =>
  n >= 999_950 ? `${(n / 1_000_000).toFixed(1)}M` : `${(n / 1000).toFixed(1)}k`

/** Wraps on word boundaries; the pane draws each line beside its own bar. */
export const wrap = (text: string, width: number): string[] => {
  const out: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line === '' ? word : `${line} ${word}`
    if (next.length > width && line !== '') {
      out.push(line)
      line = word
    } else line = next
  }
  if (line !== '') out.push(line)
  return out.length > 0 ? out : ['']
}

/** Grey bar: elapsed against the longest-running live agent. Not progress. */
export const bar = (ms: number, longest: number, w = 8): string => {
  // A clock that steps back would make ms negative, and repeat() throws on that.
  const n = Math.max(0, Math.min(w, longest > 0 ? Math.round((ms / longest) * w) : 0))
  return '█'.repeat(n) + '░'.repeat(w - n)
}

const live = (list: readonly Agent[]) => list.filter(a => a.endedAt === undefined)

/** The statuses that mean an agent's loop is over, whatever reached them. */
const OVER = new Set(['completed', 'failed', 'killed'])

/**
 * The engine's own agent list folded into what the events recorded.
 *
 * Events are quicker and they are what carries tokens and tool counts, but
 * they only see what the Agent tool spawned in a loop this plugin hooks: a
 * forked skill, another plugin's spawn, a resumed run, or a spawn whose
 * bookkeeping was lost to a reload leaves no record at all. `$.agent.list()`
 * names every agent of the session, so reconciling against it is what makes a
 * missed agent appear and a finished one stop counting as live.
 *
 * It only adds and closes, never removes: the engine drops an agent from the
 * list a while after it ends, and a row that left with it would take its
 * tokens and its place in the done count along.
 */
export const merge = (
  known: Agent[],
  seen: readonly AgentInfo[],
  now: number,
): Agent[] => {
  let out: Agent[] | undefined
  const of = (): Agent[] => (out ??= [...known])
  for (const info of seen) {
    const list = out ?? known
    // The Agent call is recorded before the spawn answers with its id, so a
    // record still waiting for one is matched by its task: without that, a
    // reconcile landing in between would draw the same agent twice.
    const at = list.findIndex(a => a.id === info.id)
    const seat =
      at >= 0
        ? at
        : list.findIndex(
            a => a.id === undefined && a.endedAt === undefined && a.desc === info.description,
          )
    const ends = OVER.has(info.status) ? now : undefined
    if (seat < 0) {
      // Nothing holds an agent's start but the event this record missed, so a
      // found agent's clock runs from the moment the pane first saw it.
      of().push({
        label: `a-${String(list.length + 1).padStart(2, '0')}`,
        callId: `list:${info.id}`,
        id: info.id,
        desc: info.description === '' ? info.type : info.description,
        type: info.type,
        model: 'inherit',
        effort: 'medium',
        startedAt: now,
        endedAt: ends,
        tools: 0,
        ctx: 0,
        out: 0,
      })
      continue
    }
    const held = list[seat] as Agent
    if (held.id === info.id && (held.endedAt !== undefined || ends === undefined)) continue
    of()[seat] = { ...held, id: info.id, endedAt: held.endedAt ?? ends }
  }
  return out ?? known
}

/**
 * The agent the stop button aims at, and the one the log tab follows unpinned:
 * the flagged one, else the one that has been running longest.
 */
export const aim = (known: readonly Zone[], list: readonly Agent[]): Agent | undefined => {
  const running = live(list)
  return (
    running.find(a => offRule(known, a) !== undefined) ??
    [...running].sort((x, y) => x.startedAt - y.startedAt)[0]
  )
}

/** The pane's bookkeeping must never break a real tool call. */
const quiet = async (work: Promise<unknown>): Promise<void> => {
  try {
    await work
  } catch {
    // a pane one beat out of date beats blocking the user's command
  }
}

/**
 * Starts, or restarts, the clock that moves the pane's elapsed times.
 *
 * A reload cancels the old timer along with the environment that held it, and
 * the engine re-fires `session.start` for changed modules only — so a reloaded
 * pane can be left with no clock at all, drawing times that never move.
 * Cancelling and re-registering is cheap and idempotent, and `/swarm` does it
 * too, so a frozen pane recovers without restarting the session.
 */
/** Folds the engine's agent list into the pane's record; see `merge`. */
const sync = async ($: EngineInterface): Promise<void> => {
  const seen = await $.agent.list()
  const now = await $.clock.now()
  // Merged twice so an unchanged list writes nothing: a write redraws every
  // reader, and this runs every second for the whole session.
  const held = await read($, agents)
  if (merge(held, seen, now) === held) return
  await update($, agents, list => merge(list, seen, now))
}

/** Whether this copy of the module has already asked for the dock. */
let asked = false

/**
 * Asks for the renderer that seats the pane beside the transcript.
 *
 * A pane's `placement` is read-only: the surface decides it, and only the
 * fullscreen layout docks one. The main screen scrolls the terminal, so there
 * is no column to the right to keep, and the pane is seated above the prompt
 * instead. Switching the renderer is the only lever a plugin has, and `/tui
 * fullscreen` saves the choice to the person's own preferences, so this runs
 * once in a session and never again after it.
 *
 * Only on a stated `false`. Unknown is not classic, and the switch restarts
 * the session: worth it once, unthinkable in a loop.
 */
const dock = async ($: EngineInterface, isFullscreen: boolean | undefined): Promise<void> => {
  if (asked || isFullscreen !== false) return
  asked = true
  // Asked once ever, not once a session. Where the fullscreen renderer cannot
  // start on this machine the session comes back on the main screen, and an ask
  // that only remembered this copy of the module would restart it again, and
  // again. One switch is a courtesy; a loop of them is a broken terminal.
  if ((await $.store.get(DOCKED)) === true) return
  await $.store.set(DOCKED, true)
  // Queued by the engine and run once the session is idle, so a turn in flight
  // finishes first and the restart resumes it where it stood.
  await $.command.run({ command: 'tui', args: 'fullscreen' })
}

const startTicker = ($: EngineInterface): void => {
  ticker?.cancel()
  ticker = $.clock.every(1000, async () => {
    await quiet(sync($))
    const list = await read($, agents)
    if (live(list).length > 0) await quiet(update($, tick, n => n + 1))
  })
}

export const register: Register = (on, options) => {
  // 'auto' reads the plan folder and, failing that, asks a small model;
  // 'plan' reads the folder only; 'off' leaves the section to the session.
  const tasksFrom = String(options?.tasks ?? 'auto')
  // 'auto' switches the renderer once so the pane is a sidebar rather than a
  // block above the prompt; 'off' leaves the person's own renderer alone.
  const dockIt = String(options?.dock ?? 'auto') !== 'off'
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'swarm', description: 'Open the subagent pane' })
    // The log tab opens with the pane, not on the first press: a tab that
    // appears only once you know the key exists is a tab nobody finds. It is
    // opened first so the swarm tab is the one in front.
    void $.ui.open({ id: LOG, title: LOG, columns: 56 })
    void $.ui.open({ id: PANE, title: PANE, columns: 56, focus: true })

    try {
      const md = await $.fs.read('CLAUDE.md')
      await update($, zones, () => parseZones(md))
    } catch {
      // No CLAUDE.md in this project: no chips, no warnings.
    }

    try {
      const planned = planIn(await $.session.messages())
      if (planned) {
        await update($, todos, () => planned)
        await update($, todoFrom, () => '')
      }
    } catch {
      // A session whose transcript cannot be read starts with an empty list.
    }

    if (tasksFrom !== 'off' && (await read($, todos)).length === 0) {
      try {
        await readPlan($, await $.clock.now())
      } catch {
        // No plans folder, or nothing readable in it: the section stays empty.
      }
    }

    startTicker($)

    return next(e)
  })

  on('command.run', { command: 'swarm' }, async $ => {
    await $.ui.open({ id: LOG, title: LOG, columns: 56 })
    await $.ui.open({ id: PANE, title: PANE, columns: 56, focus: true })
    startTicker($)
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
    // Everything before the call is bookkeeping, the clock and the toast
    // included: none of it may be what stops a real Agent call from running.
    let one: Agent | undefined
    try {
      one = {
        label: '',
        callId: e.tool_use_id,
        desc: input.description ?? 'agent',
        type: input.subagent_type ?? 'general-purpose',
        model: input.model ?? 'inherit',
        effort: input.effort ?? 'medium',
        startedAt: await $.clock.now(),
        tools: 0,
        ctx: 0,
        out: 0,
      }
      const started = one
      await update($, agents, list => [
        ...list,
        { ...started, label: `a-${String(list.length + 1).padStart(2, '0')}` },
      ])
      const warn = offRule(await read($, zones), started)
      if (warn) $.ui.toast(`⚠ ${warn}`)
    } catch {
      // a pane one beat out of date beats blocking the user's command
    }

    const ran = await next(e)
    if (one === undefined) return ran

    // The call returns the moment a background agent launches, and its record
    // carries the agentId. Taking it here, rather than waiting for the
    // agent.spawn hook, is what keeps a live agent out of the done list.
    const id = (ran as { result?: { agentId?: string } }).result?.agentId
    const closed = await $.clock.now()
    await quiet(
      update($, agents, list =>
        list.map(a =>
          a.callId === one.callId
            ? id === undefined
              ? // Nothing to follow: a remote or workflow agent ends with its call.
                { ...a, endedAt: closed }
              : { ...a, id }
            : a,
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

  // A subagent's turn carries the id the stop button needs.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined) {
      const at = await $.clock.now()
      await quiet(update($, turnAt, () => at))
    }
    if (e.agentId) {
      await quiet(
        update($, agents, list =>
          list.map(a => (a.id === e.agentId ? { ...a, turnId: e.turnId } : a)),
        ),
      )
    }
    return next(e)
  })

  // A subagent answers with its own turn.complete; that is when its run ends.
  // The session's own end is where the last of the task sources is tried.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      const done = await $.clock.now()
      await quiet(
        update($, agents, list =>
          list.map(a => (a.id === e.agentId && a.endedAt === undefined ? { ...a, endedAt: done } : a)),
        ),
      )
      return next(e)
    }

    const ran = await next(e)
    if (tasksFrom !== 'auto') return ran

    // Nothing the session or the repository wrote: a small model reads the
    // list out of the conversation, once a turn and no oftener than a minute.
    await quiet(
      (async () => {
        const held = await read($, todoFrom)
        if ((await read($, todos)).length > 0 && held !== READ) return
        const now = await $.clock.now()
        if (held === READ && now - (await read($, planAt)) < READ_EVERY) return
        const found = await readByModel($, await $.session.messages())
        if (found === undefined) return
        await update($, planAt, () => now)
        await update($, todos, () => found)
        await update($, todoFrom, () => READ)
      })(),
    )
    return ran
  })

  // Each request of an agent's turn reports what it cost. The prompt replaces
  // what the agent's last one held; only what it writes accumulates.
  on('turn.step', async function* ($, e, next) {
    const step = yield* next(e)
    const used = step.usage
    if (e.agentId && used) {
      await quiet(
        update($, agents, list => list.map(a => (a.id === e.agentId ? spend(a, used) : a))),
      )
    }
    return step
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
          (async () => {
            // The session's own plan is the one worth showing, so the main loop
            // always wins. A subagent's plan is drawn, named as its own, only
            // while the session has none of its own to show.
            const from = e.agentId ?? ''
            const held = await read($, todoFrom)
            if (from !== '' && held === '' && (await read($, todos)).length > 0) return
            await update($, todos, () => asTodos({ todos: list }) ?? [])
            await update($, todoFrom, () => from)
          })(),
        )
      }
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    // The viewport reaches a plugin on a draw alone, and says this once per
    // session; the first draw of the pane is therefore where the dock is asked
    // for. Drawing writes nothing, and this writes nothing either: the command
    // is queued, and the module's own flag keeps it to one ask.
    if (dockIt) void quiet(dock($, e.viewport?.isFullscreen))
    const list = await read($, agents)
    let tasks = await read($, todos)
    let plannedBy = await read($, todoFrom)
    if (tasksFrom !== 'off' && (tasks.length === 0 || plannedBy === PLAN)) {
      // A plan file changes under the pane; a TodoWrite announces itself.
      await quiet(readPlan($, await $.clock.now()))
      tasks = await read($, todos)
      plannedBy = await read($, todoFrom)
    }
    await read($, tick)
    const now = await $.clock.now()
    const started = await read($, turnAt)
    const turnStart = started > 0 ? started : now

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
    // Finished work is history: the last two stay for context, the rest become
    // one counted line so the open work is what fills the section.
    const keptDone = doneTasks.slice(tight ? doneTasks.length : -2)
    const hiddenDone = doneTasks.length - keptDone.length
    const shown = [...keptDone, ...(tight ? open.slice(0, Math.max(2, room - 10)) : open)]
    const longest = Math.max(1, ...running.map(a => now - a.startedAt))
    // The section's heading counts every agent that finished; the rows show the
    // last few, so the ones left out are counted on a line of their own.
    const kept = finished.slice(tight ? -1 : -2)
    const hiddenAgents = finished.length - kept.length
    const ink = (a: Agent) => INK[list.indexOf(a) % INK.length]
    const known = await read($, zones)
    const warns = running.map(a => offRule(known, a)).filter(Boolean) as string[]

    // A running agent is matched to its task row by description.
    const owner = (content: string) =>
      running.find(a => content.includes(a.desc) || a.desc.includes(content))

    /**
     * One task row. Finished work is dimmed: it reads as the history it is,
     * and the work in hand is the brightest thing in the section.
     */
    const row = (o: {
      mark: string
      markInk?: string
      text: string
      dim?: boolean
      chip?: string
      who?: string
      whoInk?: string
    }) => (
      <Box>
        {/* Fixed width: a terminal that draws a mark wide must not shift the
            text of that row, or no two rows line up. */}
        <Box width={4} flexShrink={0}>
          <Text color={o.markInk} dimColor={o.markInk === undefined}>{o.mark}</Text>
        </Box>
        <Box flexGrow={1} minWidth={0}>
          <Text wrap="truncate-end" dimColor={o.dim}>{o.text}</Text>
        </Box>
        {showChip && (
          <Box width={9} justifyContent="center">
            {o.chip ? <Text color={WARN}>{o.chip}</Text> : <Text> </Text>}
          </Box>
        )}
        {showWho && (
          <Box width={5} justifyContent="flex-end">
            {o.who ? <Text color={o.whoInk}>{o.who}</Text> : <Text> </Text>}
          </Box>
        )}
      </Box>
    )

    // The pane keeps one shape: three sections, always drawn, counts beside
    // each heading. Only what sits under a heading changes while a session runs.
    const gap = <Text> </Text>
    const head = (title: string, count: string) => (
      <Box>
        <Text bold>{title} </Text>
        <Text dimColor>{count} </Text>
        <Box flexGrow={1}><Text dimColor>{'─'.repeat(Math.max(0, w - title.length - count.length - 3))}</Text></Box>
      </Box>
    )
    const none = (what: string) => <Text dimColor>  {what}</Text>

    const target = aim(known, list)
    const summary = [
      `${doneTasks.length}/${tasks.length} tasks`,
      ...running.map(
        a =>
          `${a.label} ${a.desc} · ${a.model} · ${a.effort} · ${fmt(now - a.startedAt)} · ${ktok(tokOf(a))} tok`,
      ),
      ...warns.map(wn => `! ${wn}`),
    ].join('\n')
    const alertLines = warns.flatMap(wn =>
      wrap(`⚠ ${wn}`, Math.max(12, w - 4)).map((text, i) => ({ text, lead: i === 0 })),
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
          <Box flexGrow={1}><Text dimColor>this turn · {fmt(now - turnStart)}</Text></Box>
          <Text dimColor>
            {list.length} agents · {ktok(list.reduce((n, a) => n + tokOf(a), 0))} tok
          </Text>
        </Box>

        {head(
          'TASKS',
          `${doneTasks.length}/${tasks.length}${
            plannedBy === ''
              ? ''
              : plannedBy === PLAN
                ? ' plan'
                : plannedBy === READ
                  ? ' read'
                : ` ${list.find(a => a.id === plannedBy)?.label ?? 'agent'}`
          }`,
        )}
        {tasks.length === 0 && none('no task list in this session')}
        {hiddenDone > 0 && <Text dimColor>{MARK.completed} +{hiddenDone} done earlier</Text>}
        {shown.map(t => {
          const a = t.status === 'in_progress' ? owner(t.content) : undefined
          const mark = MARK[t.status as keyof typeof MARK] ?? MARK.pending
          const markInk =
            t.status === 'completed'
              ? OK
              : t.status === 'in_progress'
                ? (a ? ink(a) : INK[0])
                : undefined
          return row({
            mark,
            markInk,
            text: t.content,
            dim: t.status === 'completed',
            chip: zoneOf(known, t.content),
            who: a?.label,
            whoInk: a ? ink(a) : undefined,
          })
        })}

        {gap}
        {head('RUNNING', `${running.length}`)}
        {running.length === 0 && none('no agent running')}
        {running.map(a => (
          <Box flexDirection="column">
            <Box>
              <Text color={ink(a)} bold>{a.label} </Text>
              <Box flexGrow={1} minWidth={0}><Text wrap="truncate-end">{a.desc}</Text></Box>
              {!stack && <Text dimColor> {a.model} · {a.effort}</Text>}
            </Box>
            <Box paddingLeft={stack ? 0 : 5}>
              <Box flexGrow={1}>
                <Text dimColor>{bar(now - a.startedAt, longest, w < 40 ? 5 : 8)} </Text>
                <Text color={ink(a)}>{fmt(now - a.startedAt)}</Text>
              </Box>
              <Text dimColor>
                {stack ? `${a.model} · ${a.effort}` : `${ktok(tokOf(a))} tok · ${a.tools} tools`}
              </Text>
            </Box>
          </Box>
        ))}

        {/* A warning belongs beside the agent that raised it, not in a section
            of its own: the bar marks it off without costing a heading row. */}
        {alertLines.length > 0 && gap}
        {alertLines.map(line => (
          <Box>
            <Box width={2} flexShrink={0}><Text color={WARN}>▌</Text></Box>
            <Box flexGrow={1} minWidth={0}>
              <Text color={WARN} wrap="truncate-end">
                {line.lead ? line.text : `  ${line.text}`}
              </Text>
            </Box>
          </Box>
        ))}

        {gap}
        {head('DONE', `${finished.length}`)}
        {finished.length === 0 && none('nothing finished yet')}
        {hiddenAgents > 0 && (
          <Text dimColor>  +{hiddenAgents} finished earlier</Text>
        )}
        {kept.map(a => (
          <Box flexDirection="column">
            <Box>
              <Text color={OK}>{a.label} </Text>
              <Box flexGrow={1} minWidth={0}><Text dimColor wrap="truncate-end">{a.desc}</Text></Box>
              {!stack && <Text dimColor> {a.model} · {a.effort}</Text>}
            </Box>
            <Box paddingLeft={stack ? 0 : 5}>
              <Box flexGrow={1}>
                <Text dimColor>{fmt((a.endedAt ?? 0) - a.startedAt)}</Text>
              </Box>
              <Text dimColor>
                {stack ? `${a.model} · ${a.effort}` : `${ktok(tokOf(a))} tok · ${a.tools} tools`}
              </Text>
            </Box>
          </Box>
        ))}

        {gap}
        <Box gap={1}>
          {target && (
            <Button
              hotkey="s"
              label={`s stop ${target.label}`}
              onPress={async press => {
                // A subagent's own turn is what the stop ends; a refusal is reported.
                try {
                  await $.turn.abort({ turnId: target.turnId as string })
                  $.ui.toast(`${target.label} stopped`)
                } catch {
                  $.ui.toast(`${target.label} would not stop`)
                }
                void press
              }}
            />
          )}
          <Button
            hotkey="t"
            label="t open transcript"
            onPress={async () => {
              await quiet(update($, logFor, () => target?.id ?? ''))
              void $.ui.open({ id: LOG, title: LOG, columns: 56, focus: true })
            }}
          />
          <Button
            hotkey="c"
            label="c copy summary"
            onPress={press => {
              void $.ui.copy({ text: summary, surface: press.surface })
            }}
          />
        </Box>
        <Text dimColor wrap="truncate-end">
          ctrl+x tab takes the pane · Tab walks the tabs · Enter presses
        </Text>
      </Box>
    )
  })

  // The log tab: what the agent the stop button aims at has been saying.
  on('ui.render', { component: 'Pane', requestId: LOG }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    await read($, tick)
    const list = await read($, agents)
    const pinned = await read($, logFor)
    // With nothing pinned the tab follows the agent the stop button aims at, so
    // it has something to show before anyone presses anything.
    const one = list.find(a => a.id === pinned) ?? aim(await read($, zones), list)
    const id = one?.id ?? ''
    const room = e.props.scroll?.bodyRows ?? 24
    const found = id === '' ? [] : await $.session.messages({ agentId: id })
    const said = Array.isArray(found) ? found.slice(-Math.max(4, room - 3)) : []

    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={INK[0]}>{one?.label ?? '--'} </Text>
          <Box flexGrow={1} minWidth={0}>
            <Text wrap="truncate-end">{one?.desc ?? 'no agent to follow yet'}</Text>
          </Box>
        </Box>
        {said.length === 0 && (
          <Text dimColor>
            {'deny' in (found as object)
              ? 'no transcript is kept for this agent'
              : 'nothing said yet'}
          </Text>
        )}
        {said.map(m => {
          const tools = m.toolUses.map(u => u.tool).join(', ')
          const line = m.text.split('\n').find(l => l.trim() !== '') ?? tools
          return (
            <Box>
              <Text dimColor>{m.role === 'user' ? '› ' : '‹ '}</Text>
              <Box flexGrow={1} minWidth={0}>
                <Text dimColor={m.role === 'user'} wrap="truncate-end">
                  {line === '' ? '(thinking)' : line}
                </Text>
              </Box>
            </Box>
          )
        })}
      </Box>
    )
  })
}
