import { expect, test } from 'claude-code/testing'

import { aim, bar, fmt, ktok, offRule, parseZones, wrap, zoneOf } from './register'

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
  expect(ktok(0)).toBe('0.0k')
  expect(ktok(400)).toBe('0.4k')
  expect(ktok(12_700)).toBe('12.7k')

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

test('the log tab opens with the pane and says it follows nothing yet', async ($, on) => {
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

  const ui = await $.ui.mount({
    ...PANE,
    surface: 'terminal',
    requestId: 'log',
    props: { ...PANE.props, title: 'log' },
  })
  // Both tabs are there from the start; swarm is opened last, so it is in front.
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
  // All four counts go in, so the row matches what the engine reports.
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
  // 700 + 500 + 11_500 + 90_000 = 102.7k, the engine's own figure for the step.
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
