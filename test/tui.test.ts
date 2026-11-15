import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { stripAnsi, truncateVisible, visibleWidth } from '../src/tui/ansi.ts'
import { bannerLines, renderBanner } from '../src/tui/banner.ts'
import { initMenu, type Key, reduceMenu, renderMenu, selectedValues } from '../src/tui/menu.ts'
import { contextMeter, renderStatusLine, StatusBar, type StatusModel } from '../src/tui/statusbar.ts'
import { getTheme, lerpGradient } from '../src/tui/theme.ts'

const theme = getTheme('aurora')
const k = (name: string, ctrl = false): Key => ({ name, ctrl })
const press = <T extends string>(state: ReturnType<typeof initMenu<T>>, ...keys: Key[]) =>
  keys.reduce((s, key) => reduceMenu(s, key), state)

const opts = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta', disabled: true },
  { value: 'c', label: 'Gamma' },
] as const

describe('menu reducer', () => {
  it('moves with arrows, wraps around and skips disabled options', () => {
    const s = initMenu('single', opts)
    assert.equal(s.cursor, 0)
    assert.equal(press(s, k('down')).cursor, 2)
    assert.equal(press(s, k('down'), k('down')).cursor, 0)
    assert.equal(press(s, k('up')).cursor, 2)
    assert.equal(press(s, k('j'), k('k')).cursor, 0)
  })

  it('single mode submits the option under the cursor', () => {
    const s = press(initMenu('single', opts), k('down'), k('return'))
    assert.equal(s.outcome, 'submitted')
    assert.deepEqual(selectedValues(s), ['c'])
  })

  it('single mode starts on the preselected option', () => {
    assert.equal(initMenu('single', opts, ['c']).cursor, 2)
  })

  it('multi mode toggles with space, toggles all with "a" and refuses empty submit', () => {
    let s = initMenu('multi', opts)
    s = press(s, k('return'))
    assert.equal(s.outcome, 'pending')
    assert.match(s.error ?? '', /al menos una/)
    s = press(s, k('space'), k('down'), k('space'))
    assert.deepEqual(selectedValues(s), ['a', 'c'])
    s = press(s, k('space'))
    assert.deepEqual(selectedValues(s), ['a'])
    s = press(s, k('a'))
    assert.deepEqual(selectedValues(s), ['a', 'c'], 'disabled options are never selected')
    s = press(s, k('a'))
    assert.deepEqual(selectedValues(s), [])
  })

  it('ignores disabled values passed as initial selection', () => {
    assert.deepEqual(selectedValues(initMenu('multi', opts, ['b', 'c'])), ['c'])
  })

  it('escape goes back, ctrl+c aborts, and finished menus ignore further keys', () => {
    assert.equal(press(initMenu('single', opts), k('escape')).outcome, 'back')
    const aborted = press(initMenu('single', opts), k('c', true))
    assert.equal(aborted.outcome, 'aborted')
    assert.equal(press(aborted, k('down')).cursor, aborted.cursor)
  })

  it('renders pointer, checkboxes and key help without color', () => {
    const s = press(initMenu('multi', opts), k('space'))
    const out = renderMenu(s, { title: 'Pick', stepLabel: 'paso 1/3', theme, color: false })
    assert.match(out, /paso 1\/3 {2}Pick/)
    assert.match(out, /❯ ◉ Alpha/)
    assert.match(out, /◯ Beta \(no disponible\)/)
    assert.match(out, /espacio marcar/)
  })
})

describe('banner', () => {
  it('draws SEBSHELL as 6 rows of block glyphs', () => {
    const lines = bannerLines()
    assert.equal(lines.length, 6)
    assert.ok(lines.every((l) => l.length > 50))
  })

  it('falls back to a compact banner on narrow terminals', () => {
    const narrow = renderBanner({ theme, color: false, columns: 40 })
    assert.match(narrow, /S E B S H E L L/)
    const wide = renderBanner({ theme, color: true, columns: 120, subtitle: 'v0' })
    assert.equal(stripAnsi(wide).split('\n')[0], bannerLines()[0])
    assert.match(wide, /\x1b\[38;2;/)
  })

  it('interpolates gradient endpoints exactly', () => {
    assert.deepEqual(lerpGradient(theme.gradient, 0), theme.gradient[0])
    assert.deepEqual(lerpGradient(theme.gradient, 1), theme.gradient.at(-1))
  })
})

const baseModel: StatusModel = {
  orchestrator: 'claude',
  profile: 'trabajo',
  agent: 'developer',
  context: { host: 'claude', usedTokens: 136_000, windowTokens: 200_000, sessionId: 's', model: null },
  activeSubagents: ['agy:researcher'],
  services: [
    { id: 'memoseb', healthy: true },
    { id: 'herdr', healthy: false },
  ],
  busy: false,
}

describe('status bar', () => {
  it('renders orchestrator, context meter and services', () => {
    const line = renderStatusLine(baseModel, theme, false, 200)
    assert.match(line, /orq claude@trabajo:developer/)
    assert.match(line, /ctx ███████░░░ 68% \(136k\/200k\)/)
    assert.match(line, /sub 1 \(agy:researcher\)/)
    assert.match(line, /memoseb ●/)
    assert.equal(visibleWidth(line), 200, 'pads to full width')
  })

  it('shows an empty meter before the first turn and clips to the terminal width', () => {
    const line = renderStatusLine({ ...baseModel, context: null }, theme, true, 30)
    assert.match(stripAnsi(line), /ctx ░+ —|…/)
    assert.equal(visibleWidth(line), 30)
  })

  it('meter clamps out-of-range ratios', () => {
    assert.equal(contextMeter(-1), '░'.repeat(10))
    assert.equal(contextMeter(2), '█'.repeat(10))
  })

  it('pins itself to the last row via a scroll region and releases it on detach', () => {
    const writes: string[] = []
    const listeners = new Set<() => void>()
    const term = {
      isTTY: true,
      rows: 30,
      columns: 80,
      write: (c: string) => writes.push(c) > 0,
      on: (_: 'resize', l: () => void) => listeners.add(l),
      off: (_: 'resize', l: () => void) => listeners.delete(l),
    }
    const bar = new StatusBar(term, theme, false, baseModel)
    bar.attach()
    assert.ok(writes.some((w) => w.includes('\x1b[1;29r')))
    assert.ok(writes.some((w) => w.includes('\x1b[30;1H')))
    assert.ok(writes.some((w) => w.includes('\n\x1b[A\x1b7\x1b[1;29r')), 'frees a row before shrinking the region')
    term.rows = 40
    writes.length = 0
    for (const l of listeners) l()
    assert.ok(writes.some((w) => w.includes('\x1b[1;39r')), 'relayout on resize')
    assert.ok(writes.some((w) => w.includes('\x1b[30;1H\x1b[2K')), 'clears the stale bar row')
    bar.detach()
    assert.equal(listeners.size, 0)
    assert.ok(writes.at(-1)?.includes('\x1b[r'))
  })

  it('stays disabled when output is not a TTY', () => {
    const writes: string[] = []
    const bar = new StatusBar(
      { isTTY: false, rows: 30, columns: 80, write: (c) => writes.push(c) > 0, on: () => 0, off: () => 0 },
      theme,
      false,
      baseModel,
    )
    bar.attach()
    bar.update({ busy: true })
    assert.equal(writes.length, 0)
  })
})

describe('ansi helpers', () => {
  it('truncates by visible width keeping escapes intact', () => {
    const colored = '\x1b[31mhello world\x1b[0m'
    const cut = truncateVisible(colored, 6)
    assert.equal(stripAnsi(cut), 'hello…')
    assert.equal(truncateVisible('abc', 10), 'abc')
    assert.equal(truncateVisible('abcdef', 4), 'abc…', 'plain text gets no stray reset')
  })
})
