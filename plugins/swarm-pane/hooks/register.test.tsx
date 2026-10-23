import { expect, test } from 'claude-code/testing'

import {
  aim, bar, fmt, ktok, merge, offRule, parsePlan, parseZones, spend, tokOf, wrap, zoneOf,
} from './register'

const PANE = {
  plugin: 'swarm-pane',
  component: 'Pane',
  requestId: 'swarm',
  props: {
    title: 'swarm',
    isFocused: false,
    bodyColumns: 56,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 24 },
    view: {},
  },
} as const

const SAMPLE = `# CLAUDE.md

## Something else

- Billing: invoices, dunning

### Risk zones (any change here needs review)

- Checkout: payment intent, refund, stripe webhook
- Inventory: stock count, warehouse sync
- \`Auth\`: session token, password reset

## After

- Unrelated: nothing here
`

test('risk zones come from CLAUDE.md, never hardcoded', () => {
  const zones = parseZones(SAMPLE)
  expect(zones.map(z => z.label)).toEqual(['checkou', 'invento', 'auth'])

  expect(zoneOf(zones, 'fix refund rounding')).toBe('checkou')
  expect(zoneOf(zones, 'warehouse sync job')).toBe('invento')
  expect(zoneOf(zones, 'change the login button colour')).toBe(undefined)
  // A bullet outside the risk-zone section does not count.
  expect(zoneOf(zones, 'dunning email')).toBe(undefined)

  // A project that declares none gets no zones; the pane still runs.
  expect(parseZones('# CLAUDE.md\n\nNothing here.')).toEqual([])

  // The heading is matched in English and in Vietnamese, on purpose.
  const vi = parseZones('## Vùng rủi ro\n\n- Payments: refund, payout\n')
  expect(vi.map(z => z.label)).toEqual(['payment'])
})

test('a weak model in a risk zone raises a warning', () => {
  const zones = parseZones(SAMPLE)
  const weak = {
    label: 'a-04', callId: 'c', desc: 'stripe webhook retry',
    type: 'Explore', model: 'haiku', effort: 'low', startedAt: 0, tools: 0,
  }
  expect(offRule(zones, weak)).toContain('checkou')
  expect(offRule(zones, { ...weak, model: 'sonnet', effort: 'high' })).toBe(undefined)
  // Ordinary work on a weak model is fine.
  expect(offRule(zones, { ...weak, desc: 'change a button colour' })).toBe(undefined)
  // With no zones there is nothing to warn about.
  expect(offRule([], weak)).toBe(undefined)
})

test('the clock and the grey bar', () => {
  expect(fmt(0)).toBe('0:00')
  expect(fmt(161_000)).toBe('2:41')
  expect(bar(100, 100, 8)).toBe('████████')
  expect(bar(0, 100, 8)).toBe('░░░░░░░░')
  // Khong co agent nao song thi khong chia cho 0.
  expect(bar(50, 0, 8)).toBe('░░░░░░░░')
})

test('tokens read as thousands, and a warning wraps to the pane', () => {
  // An agent recorded before the pane counted tokens must not poison the total.
  expect(tokOf({})).toBe(0)
  expect(tokOf({ ctx: 1_000, out: 200 })).toBe(1_200)
  expect(ktok(0)).toBe('0.0k')
  expect(ktok(400)).toBe('0.4k')
  expect(ktok(12_700)).toBe('12.7k')
  // A long run reads in millions rather than four digits of thousands.
  expect(ktok(1_240_000)).toBe('1.2M')
  expect(ktok(999_949)).toBe('999.9k')
  expect(ktok(999_950)).toBe('1.0M')

  const lines = wrap('a-04 works on checkout with haiku, the rule asks sonnet', 24)
  expect(lines.every(l => l.length <= 24)).toBe(true)
  expect(lines.join(' ')).toBe('a-04 works on checkout with haiku, the rule asks sonnet')
  // A word longer than the width is not cut in half; it gets its own line.
  expect(wrap('supercalifragilistic x', 8)).toEqual(['supercalifragilistic', 'x'])
  expect(wrap('', 8)).toEqual([''])
})

test('the pane lists an agent with its model and effort', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'review the permission matrix',
    prompt: 'x',
    subagent_type: 'Explore',
    model: 'haiku',
    effort: 'low',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /permission/ }))?.text).toContain('permission')
  expect((await ui.find({ type: 'Text', text: /haiku/ }))?.text).toContain('low')
  await ui.unmount()
})

test('a narrow pane keeps model and effort, dropping optional columns', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ result: {} }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'dev check C2',
    prompt: 'x',
    subagent_type: 'general-purpose',
    model: 'sonnet',
    effort: 'medium',
  })

  for (const bodyColumns of [36, 72]) {
    const ui = await $.ui.mount({
      ...PANE,
      surface: 'terminal',
      props: { ...PANE.props, bodyColumns },
    })
    // Model and effort are the point of the pane; no width may drop them.
    expect((await ui.find({ type: 'Text', text: /sonnet/ }))?.text).toContain('medium')
    await ui.unmount()
  }
})

test('an agent that reports no agentId closes when its call returns', async ($, on) => {
  // The harness does not run agent.spawn, so this covers the fallback: a remote
  // (workflow) agent reports no agentId and can only close when its call returns.
  // The main path — a background agent closing on turn.complete — is checked live.
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'remote workflow step',
    prompt: 'x',
    subagent_type: 'general-purpose',
    model: 'sonnet',
    effort: 'medium',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /DONE/ }))?.text).toContain('DONE')
  await ui.unmount()
})

test('the three headings stay on an empty session', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Nothing has happened yet: the shape is the same, only the rows under it differ.
  for (const heading of ['TASKS', 'RUNNING', 'DONE']) {
    expect((await ui.find({ type: 'Text', text: new RegExp(`^${heading}\\s*$`) }))?.text).toContain(heading)
  }
  expect((await ui.find({ type: 'Text', text: /no agent running/ }))?.text).toContain('no agent')
  await ui.unmount()
})

test('an agent whose call reports an agentId stays in RUNNING', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // A background agent's call returns at launch and hands back its id.
  on('tool.call', () => ({ result: { agentId: 'ag-7' } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'review the pane code',
    prompt: 'x',
    subagent_type: 'general-purpose',
    model: 'sonnet',
    effort: 'medium',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // It launched and has not finished: RUNNING holds it, DONE is still empty.
  expect(await ui.find({ type: 'Text', text: /no agent running/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /nothing finished yet/ }))?.text)
    .toContain('nothing finished')
  expect((await ui.find({ type: 'Text', text: /review the pane code/ }))?.text)
    .toContain('review the pane code')
  await ui.unmount()
})

test('a flagged agent raises a bar under the running list, not a section', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('fs.read', () => ({ value: SAMPLE }))
  on('tool.call', () => ({ result: { agentId: 'ag-9' } }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'stripe webhook retry',
    prompt: 'x',
    subagent_type: 'general-purpose',
    model: 'haiku',
    effort: 'low',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /⚠/ }))?.text).toContain('⚠')
  expect((await ui.find({ type: 'Text', text: /▌/ }))?.text).toContain('▌')
  // The warning sits beside its agent; no heading of its own is drawn.
  expect(await ui.find({ type: 'Text', text: /^ALERTS\s*$/ })).toBe(undefined)
  await ui.unmount()
})

test('the pane waits for /swarm, and the log tab opens with it', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // A session that starts opens nothing; only the command does.
  expect(opened).toEqual([])
  await $.command.run({ command: 'swarm' })

  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    requestId: 'log',
    props: { ...PANE.props, title: 'log' },
  })
  // Both tabs open together; swarm is opened last, so it is in front.
  expect(opened).toEqual(['log', 'swarm'])
  expect((await ui.find({ type: 'Text', text: /no agent/ }))?.text).toContain('follow')
  await ui.unmount()
})

test('an agent carries the tokens its own steps paid for', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  on('tool.call', () => ({ result: { agentId: 'ag-3' } }))
  on('turn.step', async function* () {
    return {
      turnId: 't1',
      index: 0,
      answer: '',
      toolUses: [],
      stopReason: 'tool_use',
      usage: {
        input_tokens: 700,
        output_tokens: 500,
        cache_creation_input_tokens: 11_500,
        cache_read_input_tokens: 90_000,
        model: 'sonnet',
      },
    }
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'dev check C2',
    prompt: 'x',
    subagent_type: 'general-purpose',
    model: 'sonnet',
    effort: 'medium',
  })
  const stream = $.turn.step({ turnId: 't1', index: 0, model: 'sonnet', messageCount: 4, agentId: 'ag-3' })
  for await (const _chunk of stream) void _chunk

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The whole prompt, 102.2k, plus the 500 it wrote.
  expect((await ui.find({ type: 'Text', text: /tok · / }))?.text).toContain('102.7k tok')
  expect((await ui.find({ type: 'Text', text: /agents · / }))?.text).toContain('102.7k tok')
  await ui.unmount()
})

test('a TodoWrite fills the task list the pane draws', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.read', () => ({ value: SAMPLE }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'read the README', status: 'completed', activeForm: 'reading' },
      { content: 'check the refund path', status: 'in_progress', activeForm: 'checking' },
      { content: 'write up the gaps', status: 'pending', activeForm: 'writing' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /TASKS/ }))?.text).toContain('TASKS')
  expect((await ui.find({ type: 'Text', text: /refund path/ }))?.text).toContain('refund')
  // A task touching a declared zone carries its chip.
  expect((await ui.find({ type: 'Text', text: /^checkou$/ }))?.text).toBe('checkou')
  await ui.unmount()
})

test("a subagent's plan shows until the session has one of its own", async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'ag-5',
    todos: [{ content: 'the subagent plan', status: 'in_progress', activeForm: 'planning' }],
  })

  // Nothing else is planned, so the subagent's list is better than an empty section.
  let ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /subagent plan/ }))?.text).toContain('subagent plan')
  await ui.unmount()

  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'the session plan', status: 'pending', activeForm: 'planning' }],
  })
  // The session's own plan takes the section, and a later subagent cannot take it back.
  await $.tool.call({
    tool: 'TodoWrite',
    agentId: 'ag-5',
    todos: [{ content: 'a second subagent plan', status: 'pending', activeForm: 'planning' }],
  })

  ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /session plan/ }))?.text).toContain('session plan')
  expect(await ui.find({ type: 'Text', text: /second subagent/ })).toBe(undefined)
  await ui.unmount()
})

test('the stop button and the log tab aim at the same agent', () => {
  const known = parseZones(SAMPLE)
  const base = { callId: 'c', type: 'general-purpose', effort: 'medium', tools: 0, tok: 0 }
  const old = { ...base, label: 'a-01', desc: 'tidy the readme', model: 'sonnet', startedAt: 10 }
  const flagged = { ...base, label: 'a-02', desc: 'refund rounding', model: 'haiku', startedAt: 50 }
  const done = { ...base, label: 'a-03', desc: 'older still', model: 'opus', startedAt: 1, endedAt: 2 }

  // Longest-running while nothing is flagged; a finished agent is never aimed at.
  expect(aim(known, [done, old, flagged])?.label).toBe('a-02')
  expect(aim(known, [done, old])?.label).toBe('a-01')
  expect(aim(known, [done])).toBe(undefined)
})

test('the header counts every agent, and DONE accounts for the rows it drops', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.toast', () => ({ value: undefined }))
  // No agentId: each call ends with itself, so all three land in DONE.
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  for (const description of ['first errand', 'second errand', 'third errand']) {
    await $.tool.call({
      tool: 'Agent',
      description,
      prompt: 'x',
      subagent_type: 'general-purpose',
      model: 'sonnet',
      effort: 'medium',
    })
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Three ran, none is running: the header still counts all three.
  expect((await ui.find({ type: 'Text', text: /agents · / }))?.text).toContain('3 agents')
  // Two rows fit; the third is counted rather than silently dropped.
  expect((await ui.find({ type: 'Text', text: /finished earlier/ }))?.text).toContain('+1')
  expect((await ui.find({ type: 'Text', text: /third errand/ }))?.text).toContain('third')
  expect(await ui.find({ type: 'Text', text: /first errand/ })).toBe(undefined)
  await ui.unmount()
})

test('a step replaces the prompt and adds only what was written', () => {
  const one = {
    label: 'a-01', callId: 'c', desc: 'x', type: 'general-purpose',
    model: 'sonnet', effort: 'medium', startedAt: 0, tools: 0, ctx: 0, out: 0,
  }
  const first = spend(one, {
    input_tokens: 700, output_tokens: 500,
    cache_creation_input_tokens: 11_500, cache_read_input_tokens: 90_000,
  })
  expect(tokOf(first)).toBe(102_700)

  // The same context, read again, is the same prompt: the figure follows the
  // latest prompt plus every answer, never the prompts added together.
  const second = spend(first, {
    input_tokens: 500, output_tokens: 400,
    cache_creation_input_tokens: 8_000, cache_read_input_tokens: 103_000,
  })
  expect(tokOf(second)).toBe(112_400)
  expect(ktok(tokOf(second))).toBe('112.4k')

  // An agent recorded before the pane counted tokens starts from zero.
  expect(tokOf(spend({ ...one, out: undefined as unknown as number }, {
    input_tokens: 10, output_tokens: 20,
    cache_creation_input_tokens: 0, cache_read_input_tokens: 0,
  }))).toBe(30)
})

test('a plan written before the pane loaded is picked up from the transcript', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({
    value: [
      { role: 'user', text: 'do the thing', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          { tool: 'TodoWrite', input: { todos: [{ content: 'an older plan', status: 'completed' }] } },
          { tool: 'Read', input: { file_path: '/x' } },
        ],
      },
      {
        role: 'assistant',
        text: '',
        toolUses: [
          {
            tool: 'TodoWrite',
            input: {
              todos: [
                { content: 'build the thing', status: 'completed' },
                { content: 'check the thing', status: 'in_progress' },
              ],
            },
          },
        ],
      },
    ],
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // The newest plan in the transcript, not the one before it.
  expect((await ui.find({ type: 'Text', text: /check the thing/ }))?.text).toContain('check')
  expect(await ui.find({ type: 'Text', text: /an older plan/ })).toBe(undefined)
  expect((await ui.find({ type: 'Text', text: /^1\/2\s*$/ }))?.text).toContain('1/2')
  await ui.unmount()
})

test('every task mark is ASCII and holds the same width', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'first', status: 'completed', activeForm: 'a' },
      { content: 'second', status: 'in_progress', activeForm: 'b' },
      { content: 'third', status: 'pending', activeForm: 'c' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  const marks = (await ui.findAll({ type: 'Text' }))
    .map(t => String(t.text ?? ''))
    .filter(t => /^\[.\]$/.test(t))
  expect(marks.length).toBe(3)
  // One width for every row, and no character a terminal may draw double.
  expect(new Set(marks.map(m => m.length)).size).toBe(1)
  // eslint-disable-next-line no-control-regex
  expect(marks.every(m => /^[\x20-\x7e]+$/.test(m))).toBe(true)
  await ui.unmount()
})

test('checkbox rows of a plan file become the task list', () => {
  const plan = `# Phase 02

## Todo List

- [x] dựng case PIT ngưỡng 5tr
- [~] test ranh giới PIT tháng
- [ ] **soát** ma trận phân quyền
* [X] backup trước migration

Not a task: - [x] inside a sentence is still a row, a bare - dash is not.
- just a bullet
- [ ]
`
  const found = parsePlan(plan)
  // The row inside a sentence is not a row: a task line starts its own line.
  expect(found.map(t => t.status)).toEqual(['completed', 'in_progress', 'pending', 'completed'])
  // Emphasis is stripped, and an empty row is no task.
  expect(found[2]?.content).toBe('soát ma trận phân quyền')
  expect(found.some(t => t.content === '')).toBe(false)
  expect(parsePlan('nothing here')).toEqual([])
})

test('the pane draws the newest plan folder that holds a list', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('session.messages', () => ({ value: [] }))
  on('fs.list', (_, e) => ({
    value:
      String(e.path).endsWith('plans')
        ? [
            { name: '261020-0900-older', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
            { name: '261021-1530-newest', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
            // Both sort after a date by name, and neither is a plan.
            { name: 'reports', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
            { name: '_archive', kind: 'dir', size: 0, mtimeMs: 0, isLink: false },
          ]
        : [
            { name: 'phase-01-build.md', kind: 'file', size: 10, mtimeMs: 0, isLink: false },
            { name: 'notes.txt', kind: 'file', size: 10, mtimeMs: 0, isLink: false },
          ],
  }))
  on('fs.read', (_, e) => ({
    value: String(e.path).includes('261021-1530-newest')
      ? '# Brief\n\nNo checkbox lives here.\n'
      : String(e.path).includes('reports')
        ? '- [x] a finding from an old report\n'
        : '## Todo List\n- [x] built the thing\n- [ ] check the thing\n',
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /check the thing/ }))?.text).toContain('check')
  // The newest folder holds only a brief, so the one before it is read; a
  // report folder is never a plan.
  expect(await ui.find({ type: 'Text', text: /old report/ })).toBe(undefined)
  // The heading says where the list came from.
  expect((await ui.find({ type: 'Text', text: /1\/2 plan/ }))?.text).toContain('plan')
  await ui.unmount()
})

test('a small model reads the list when nothing else wrote one', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [] }))
  on('session.messages', () => ({
    value: [{ role: 'user', text: 'fix the pane', toolUses: [] }],
  }))
  on('turn.complete', () => ({ text: 'done' }))
  on('model.complete', () => ({
    value: {
      isAnswered: true,
      text: '- [x] read the hook\n- [~] fix the header\n- [ ] run the tests\n',
      usage: {
        input_tokens: 900, output_tokens: 40,
        cache_creation_input_tokens: 0, cache_read_input_tokens: 0, model: 'haiku',
      },
    },
  }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({
    text: 'done', answer: 'done', durationMs: 10, isAborted: false,
    turnId: 't1', reason: 'answer',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /fix the header/ }))?.text).toContain('header')
  // The heading says the list was read, not written by the session.
  expect((await ui.find({ type: 'Text', text: /1\/3 read/ }))?.text).toContain('read')
  await ui.unmount()
})

test('finished work is dimmed and the work in hand is not', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [
      { content: 'the finished one', status: 'completed', activeForm: 'a' },
      { content: 'the one in hand', status: 'in_progress', activeForm: 'b' },
      { content: 'the one to come', status: 'pending', activeForm: 'c' },
    ],
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /finished one/ }))?.props?.dimColor).toBe(true)
  expect((await ui.find({ type: 'Text', text: /in hand/ }))?.props?.dimColor).toBeFalsy()
  expect((await ui.find({ type: 'Text', text: /to come/ }))?.props?.dimColor).toBeFalsy()
  await ui.unmount()
})

test("the engine's own list fills in what the events missed", () => {
  const known = [{
    label: 'a-01', callId: 'c1', id: 'ag-1', desc: 'review the diff',
    type: 'general-purpose', model: 'sonnet', effort: 'high',
    startedAt: 1_000, tools: 7, ctx: 90_000, out: 2_000,
  }]
  const found = merge(known, [
    { id: 'ag-1', description: 'review the diff', type: 'general-purpose', status: 'running' },
    { id: 'ag-2', description: 'run the suite', type: 'Explore', status: 'running' },
  ], 5_000)

  // The agent nothing recorded is drawn, and the one that was keeps its count.
  expect(found.map(a => a.label)).toEqual(['a-01', 'a-02'])
  expect(found[1]?.desc).toBe('run the suite')
  expect(found[0]?.tools).toBe(7)
  expect(found[0]?.ctx).toBe(90_000)

  // A finished agent stops running, and an unchanged list writes nothing.
  const over = merge(found, [
    { id: 'ag-1', description: 'review the diff', type: 'general-purpose', status: 'completed' },
    { id: 'ag-2', description: 'run the suite', type: 'Explore', status: 'running' },
  ], 9_000)
  expect(over[0]?.endedAt).toBe(9_000)
  expect(over[1]?.endedAt).toBe(undefined)
  expect(merge(over, [
    { id: 'ag-1', description: 'review the diff', type: 'general-purpose', status: 'completed' },
    { id: 'ag-2', description: 'run the suite', type: 'Explore', status: 'running' },
  ], 12_000)).toBe(over)

  // An agent dropped from the list keeps its row: its tokens are in it.
  expect(merge(over, [], 13_000)).toBe(over)
})

test('a record still waiting for its id is not drawn twice', () => {
  const waiting = [{
    label: 'a-01', callId: 'c1', desc: 'review the diff', type: 'general-purpose',
    model: 'sonnet', effort: 'high', startedAt: 1_000, tools: 0, ctx: 0, out: 0,
  }]
  const found = merge(waiting, [
    { id: 'ag-1', description: 'review the diff', type: 'general-purpose', status: 'running' },
  ], 2_000)
  expect(found).toHaveLength(1)
  expect(found[0]?.id).toBe('ag-1')
  expect(found[0]?.callId).toBe('c1')
})

test('the pane asks for the renderer that seats it on the right, once', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  const kept: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: kept[e.key] }))
  on('store.set', (_, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  const ran: string[] = []
  on('command.run', (_, e) => {
    ran.push(`${e.command} ${e.args}`.trim())
    return { text: '' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  // The main screen seats a pane above the prompt, so the renderer is asked for.
  const inline = await $.ui.mount({
    ...PANE, surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen: false },
  })
  await inline.unmount()
  expect(ran).toEqual(['tui fullscreen'])

  // Asked once ever: a renderer that cannot start would otherwise be asked for
  // again on the session that came back without it, and again after that.
  const again = await $.ui.mount({
    ...PANE, surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen: false },
  })
  await again.unmount()
  expect(ran).toEqual(['tui fullscreen'])
})

test('the restart /swarm asked for reopens the pane in that session alone', async ($, on) => {
  const opened: string[] = []
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  let sessionId = 'asked'
  on('session.id', () => ({ value: sessionId }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  const kept: Record<string, unknown> = {}
  on('store.get', (_, e) => ({ value: kept[e.key] }))
  on('store.set', (_, e) => {
    kept[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete kept[e.key]
    return { value: undefined }
  })
  on('command.run', () => ({ text: '' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const inline = await $.ui.mount({
    ...PANE, surface: 'terminal', viewport: { columns: 120, rows: 40, isFullscreen: false },
  })
  await inline.unmount()
  expect(opened).toEqual([])

  // The restart resumes the same session, which comes back with its tabs.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['log', 'swarm'])

  // Once: the next start of it opens nothing.
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['log', 'swarm'])

  // A restart that never came back leaves its mark for another session to find,
  // which clears it and opens nothing.
  kept['reopen-after-the-dock'] = 'asked'
  sessionId = 'later'
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(opened).toEqual(['log', 'swarm'])
  expect(kept['reopen-after-the-dock']).toBeUndefined()
})

test('a pane the surface already docks asks for nothing', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  const ran: string[] = []
  on('command.run', (_, e) => {
    ran.push(e.command)
    return { text: '' }
  })

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  // Fullscreen docks it, and an unknown viewport is not a classic one.
  for (const viewport of [
    { columns: 120, rows: 40, isFullscreen: true },
    { columns: 120, rows: 40 },
  ]) {
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal', viewport })
    await ui.unmount()
  }
  expect(ran).toEqual([])
})

test('every section heading is a bar in theme colours, and the pane is unfilled', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

  // A theme key, never a hex: the bar follows a light theme and a dark one.
  for (const title of [/^TASKS /, /^RUNNING /, /^DONE /]) {
    const found = await ui.find({ type: 'Text', text: title })
    expect(found?.props?.backgroundColor).toBe('subtle')
    expect(found?.props?.color).toBe('inverseText')
  }

  // Nothing fills the column unless the person asks: a hex background follows
  // no theme, and a filled column takes the terminal's own transparency with it.
  const root = await ui.find({ type: 'Box', props: { flexDirection: 'column' } })
  expect(root).toBeDefined()
  expect(root?.props?.backgroundColor).toBe(undefined)
  await ui.unmount()
})

test('the heading letters take a colour of their own',
  { options: { heading: '#303048', headingText: '#f2c14e' } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'swarm' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('clock.now', () => ({ value: 1_000_000 }))
    on('clock.every', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    // The bar keeps its own colour; the title no longer reads 'inverseText'.
    const title = await ui.find({ type: 'Text', text: /^TASKS / })
    expect(title?.props?.backgroundColor).toBe('#303048')
    expect(title?.props?.color).toBe('#f2c14e')
    await ui.unmount()
  })

test('the letters take a colour with the bar off too',
  { options: { heading: 'off', headingText: 'claude' } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'swarm' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('clock.now', () => ({ value: 1_000_000 }))
    on('clock.every', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    // No bar to read against, so the letters sit on the terminal's own ground.
    const title = await ui.find({ type: 'Text', text: /^TASKS/ })
    expect(title?.props?.backgroundColor).toBe(undefined)
    expect(title?.props?.color).toBe('claude')
    await ui.unmount()
  })

test('the colours are the person\'s to set', { options: { heading: 'off', background: '#1b1b2a' } },
  async ($, on) => {
    on('command.register', () => ({ value: { command: 'swarm' } }))
    on('ui.open', () => ({ value: { isPlaced: true } }))
    on('session.start', (_, e) => ({ cwd: e.cwd }))
    on('clock.now', () => ({ value: 1_000_000 }))
    on('clock.every', () => ({ value: undefined }))

    await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })

    // 'off' is the plain heading again, with the rule after it and no bar.
    const title = await ui.find({ type: 'Text', text: /^TASKS/ })
    expect(title?.props?.backgroundColor).toBe(undefined)
    expect(await ui.find({ type: 'Text', text: /─/ })).toBeDefined()

    // A fill is held to the room the pane was given, or it ends ragged.
    const root = await ui.find({ type: 'Box', props: { flexDirection: 'column' } })
    expect(root?.props?.backgroundColor).toBe('#1b1b2a')
    expect(root?.props?.minHeight).toBe(PANE.props.scroll.bodyRows)
    await ui.unmount()
  })

test('a cleared conversation leaves no agent and no task behind', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId ?? 'cleared' }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))
  on('tool.call', () => ({ result: {} }))
  // No plans folder: the task list has nothing to fall back to after the clear.
  on('fs.list', () => ({ deny: 'no such folder' }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.tool.call({
    tool: 'Agent',
    description: 'review the diff',
    prompt: 'x',
    subagent_type: 'general-purpose',
    model: 'sonnet',
    effort: 'medium',
  })
  await $.tool.call({
    tool: 'TodoWrite',
    todos: [{ content: 'fix the token count', status: 'completed', activeForm: 'a' }],
  })

  const before = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await before.find({ type: 'Text', text: /review the diff/ }))?.text).toBeDefined()
  expect((await before.find({ type: 'Text', text: /token count/ }))?.text).toBeDefined()
  await before.unmount()

  // The engine raises no session.start for what follows a clear, so the end of
  // the cleared conversation is the only place the pane can empty itself.
  await $.session.end({ reason: 'clear' })

  const after = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect(await after.find({ type: 'Text', text: /review the diff/ })).toBe(undefined)
  expect(await after.find({ type: 'Text', text: /token count/ })).toBe(undefined)
  expect((await after.find({ type: 'Text', text: /agents · / }))?.text).toContain('0 agents')
  expect((await after.find({ type: 'Text', text: /no task list/ }))?.text).toBeDefined()
  await after.unmount()
})
