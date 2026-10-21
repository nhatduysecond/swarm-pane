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

test('vung rui ro doc tu CLAUDE.md, khong gan cung du an nao', () => {
  const zones = parseZones(SAMPLE)
  expect(zones.map(z => z.label)).toEqual(['checkou', 'invento', 'auth'])

  expect(zoneOf(zones, 'fix refund rounding')).toBe('checkou')
  expect(zoneOf(zones, 'warehouse sync job')).toBe('invento')
  expect(zoneOf(zones, 'đổi màu nút đăng nhập')).toBe(undefined)
  // Muc ngoai phan risk zone khong duoc tinh.
  expect(zoneOf(zones, 'dunning email')).toBe(undefined)

  // Du an khong khai thi khong co vung nao, pane van chay.
  expect(parseZones('# CLAUDE.md\n\nNothing here.')).toEqual([])
})

test('rule chan model yeu o vung rui ro', () => {
  const zones = parseZones(SAMPLE)
  const weak = {
    label: 'a-04', callId: 'c', desc: 'stripe webhook retry',
    type: 'Explore', model: 'haiku', effort: 'low', startedAt: 0, tools: 0,
  }
  expect(offRule(zones, weak)).toContain('checkou')
  expect(offRule(zones, { ...weak, model: 'sonnet', effort: 'high' })).toBe(undefined)
  // Viec thuong thi model yeu van duoc.
  expect(offRule(zones, { ...weak, desc: 'đổi màu nút' })).toBe(undefined)
  // Khong co vung nao thi khong canh bao gi.
  expect(offRule([], weak)).toBe(undefined)
})

test('dong ho va thanh xam', () => {
  expect(fmt(0)).toBe('0:00')
  expect(fmt(161_000)).toBe('2:41')
  expect(bar(100, 100, 8)).toBe('████████')
  expect(bar(0, 100, 8)).toBe('░░░░░░░░')
  // Khong co agent nao song thi khong chia cho 0.
  expect(bar(50, 0, 8)).toBe('░░░░░░░░')
})

test('pane liet ke agent dang chay kem model va effort', async ($, on) => {
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
    description: 'soát ma trận phân quyền',
    prompt: 'x',
    subagent_type: 'Explore',
    model: 'haiku',
    effort: 'low',
  })

  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  expect((await ui.find({ type: 'Text', text: /ma trận/ }))?.text).toContain('ma trận')
  expect((await ui.find({ type: 'Text', text: /haiku/ }))?.text).toContain('low')
  await ui.unmount()
})

test('pane hep van giu model va effort, chi bo cot phu', async ($, on) => {
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
    // Model va effort la thu sep can nhat, khong duoc rot o be rong nao.
    expect((await ui.find({ type: 'Text', text: /sonnet/ }))?.text).toContain('medium')
    await ui.unmount()
  }
})
