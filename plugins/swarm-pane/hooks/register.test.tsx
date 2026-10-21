import { expect, test } from 'claude-code/testing'

import { bar, fmt, offRule, parseZones, zoneOf } from './register'

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

test('the four headings stay on an empty session', async ($, on) => {
  on('command.register', () => ({ value: { command: 'swarm' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.now', () => ({ value: 1_000_000 }))
  on('clock.every', () => ({ value: undefined }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  // Nothing has happened yet: the shape is the same, only the rows under it differ.
  for (const heading of ['TASKS', 'RUNNING', 'ALERTS', 'DONE']) {
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
