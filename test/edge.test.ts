import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { ProcessOutcome } from 'hubseb'
import { normalizeConfig } from '../src/config.ts'
import { parseTurnOutput, runTurn } from '../src/dispatch.ts'
import { runInstall } from '../src/installer.ts'
import { contextRatio, lastJsonObject, parseClaudeResult } from '../src/usage.ts'
import { stripAnsi, truncateVisible, visibleWidth } from '../src/tui/ansi.ts'
import { initMenu, type Key, reduceMenu, renderMenu, selectedValues } from '../src/tui/menu.ts'
import { renderStatusLine, StatusBar, type StatusModel } from '../src/tui/statusbar.ts'
import { getTheme } from '../src/tui/theme.ts'

const theme = getTheme('aurora')
const k = (name: string, ctrl = false): Key => ({ name, ctrl })
const out = (stdout: string, exitCode = 0, stderr = ''): ProcessOutcome => ({ stdout, stderr, exitCode }) as ProcessOutcome

describe('menu edge cases', () => {
  for (const mode of ['single', 'multi'] as const) {
    it(`${mode}: empty list never throws and cursor stays 0`, () => {
      let s = initMenu(mode, [])
      for (const name of ['down', 'up', 'space', 'a', 'tab']) s = reduceMenu(s, k(name))
      assert.equal(s.cursor, 0)
      assert.equal(s.outcome, 'pending')
      assert.deepEqual(selectedValues(s), [])
      assert.doesNotThrow(() => renderMenu(s, { title: 't', theme, color: false }))
    })

    it(`${mode}: all disabled keeps cursor and cannot submit a value`, () => {
      const options = [
        { value: 'a', label: 'A', disabled: true },
        { value: 'b', label: 'B', disabled: true },
      ]
      let s = initMenu(mode, options, ['a'])
      assert.equal(s.selected.size, 0)
      s = reduceMenu(reduceMenu(s, k('down')), k('up'))
      assert.equal(s.cursor, 0)
      s = reduceMenu(reduceMenu(s, k('space')), k('a'))
      assert.equal(s.selected.size, 0)
      s = reduceMenu(s, k('return'))
      assert.deepEqual(selectedValues(s), [])
      assert.notEqual(s.outcome === 'submitted' && mode === 'single', true)
    })
  }

  it('multi: "a" over all-disabled does not select anything', () => {
    const s = reduceMenu(initMenu('multi', [{ value: 'x', label: 'X', disabled: true }]), k('a'))
    assert.equal(s.selected.size, 0)
  })

  it('ctrl+c aborts and later keys are ignored', () => {
    const s = reduceMenu(initMenu('single', [{ value: 'a', label: 'A' }]), k('c', true))
    assert.equal(s.outcome, 'aborted')
    assert.equal(reduceMenu(s, k('return')).outcome, 'aborted')
  })
})

describe('truncateVisible edge cases', () => {
  it('width 1 yields only the ellipsis', () => {
    assert.equal(truncateVisible('hello', 1), '…')
    assert.equal(stripAnsi(truncateVisible('\x1b[1mhello\x1b[0m', 1)), '…')
  })

  it('never splits astral surrogate pairs', () => {
    const t = truncateVisible('😀😀😀😀', 3)
    assert.equal(t, '😀😀…')
    assert.doesNotMatch(t, /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
    assert.equal(visibleWidth(t), 3)
  })

  it('width 0 / negative returns empty; fitting text untouched', () => {
    assert.equal(truncateVisible('abc', 0), '')
    assert.equal(truncateVisible('abc', -5), '')
    assert.equal(truncateVisible('😀', 1), '😀')
  })

  it('closes styling with reset when truncating colored text', () => {
    const t = truncateVisible('\x1b[31mabcdef\x1b[0m', 4)
    assert.equal(stripAnsi(t), 'abc…')
    assert.ok(t.endsWith('\x1b[0m'))
  })
})

describe('statusbar edge cases', () => {
  const model: StatusModel = {
    orchestrator: 'claude',
    profile: null,
    agent: null,
    context: null,
    activeSubagents: [],
    services: [],
    busy: false,
  }
  const fakeTerm = (rows: number | undefined, isTTY = true) => {
    const writes: string[] = []
    const listeners: (() => void)[] = []
    return {
      writes,
      listeners,
      rows,
      columns: 80,
      isTTY,
      write: (c: string) => (writes.push(c), true),
      on: (_: 'resize', l: () => void) => listeners.push(l),
      off: (_: 'resize', l: () => void) => {
        const i = listeners.indexOf(l)
        if (i >= 0) listeners.splice(i, 1)
      },
    }
  }

  it('rows < 4 (or undefined, or non-TTY) disables the bar and writes nothing', () => {
    for (const term of [fakeTerm(3), fakeTerm(0), fakeTerm(undefined), fakeTerm(24, false)]) {
      const bar = new StatusBar(term, theme, false, model)
      assert.equal(bar.enabled, false)
      bar.attach()
      bar.update({ busy: true })
      bar.detach()
      assert.deepEqual(term.writes, [])
      assert.equal(term.listeners.length, 0)
    }
  })

  it('rows == 4 enables; attach is idempotent and detach unsubscribes', () => {
    const term = fakeTerm(4)
    const bar = new StatusBar(term, theme, false, model)
    bar.attach()
    bar.attach()
    assert.equal(term.listeners.length, 1)
    bar.detach()
    bar.detach()
    assert.equal(term.listeners.length, 0)
  })

  it('window 0 yields ratio 0 and no NaN in the line', () => {
    const ctx = { host: 'claude', usedTokens: 500, windowTokens: 0, sessionId: null, model: null } as const
    assert.equal(contextRatio(ctx), 0)
    const line = renderStatusLine({ ...model, context: ctx }, theme, false, 120)
    assert.ok(!line.includes('NaN'))
    assert.ok(line.includes('0%'))
  })

  it('tiny column counts keep line within width', () => {
    for (const cols of [1, 2, 5]) {
      assert.ok(visibleWidth(renderStatusLine(model, theme, false, cols)) <= cols)
    }
  })

  it('used > window clamps to 100%', () => {
    const ctx = { host: 'claude', usedTokens: 900, windowTokens: 100, sessionId: null, model: null } as const
    assert.equal(contextRatio(ctx), 1)
  })
})

describe('usage edge cases', () => {
  it('lastJsonObject skips trailing garbage and truncated JSON', () => {
    const nd = '{"a":1}\n{"b":2}\nnot json\n{"c":\n\n'
    assert.deepEqual(lastJsonObject(nd), { b: 2 })
  })

  it('lastJsonObject returns null for empty, array-only or garbage output', () => {
    assert.equal(lastJsonObject(''), null)
    assert.equal(lastJsonObject('[1,2]\nfoo'), null)
    assert.equal(lastJsonObject('{{{'), null)
  })

  it('lastJsonObject tolerates CRLF line endings', () => {
    assert.deepEqual(lastJsonObject('{"a":1}\r\n{"b":2}\r\n'), { b: 2 })
  })

  it('empty iterations fall back to top-level usage', () => {
    const snap = parseClaudeResult({
      type: 'result',
      usage: { input_tokens: 10, cache_read_input_tokens: 5, iterations: [] },
    })
    assert.equal(snap?.usedTokens, 15)
  })

  it('non-object last iteration falls back to top-level usage; missing usage returns null', () => {
    const snap = parseClaudeResult({ type: 'result', usage: { input_tokens: 7, iterations: [null] } })
    assert.equal(snap?.usedTokens, 7)
    assert.equal(parseClaudeResult({ type: 'result' }), null)
    assert.equal(parseClaudeResult('result'), null)
  })

  it('string / NaN token counts are treated as 0', () => {
    const snap = parseClaudeResult({ type: 'result', usage: { input_tokens: '9', cache_read_input_tokens: Number.NaN } })
    assert.equal(snap?.usedTokens, 0)
  })
})

describe('installer edge cases', () => {
  it('exec throwing is reported as failed, skips setup, continues with others', async () => {
    const calls: string[] = []
    const reports = await runInstall(
      {
        locate: (b) => (b === 'npm' ? '/bin/npm' : null),
        exec: async (_bin, args) => {
          calls.push(args.join(' '))
          if (args.includes('memoseb')) throw new Error('spawn EACCES')
          return out('')
        },
      },
      { components: ['memoseb', 'crewseb'], hosts: ['claude'] },
    )
    const mem = reports.filter((r) => r.component === 'memoseb')
    assert.equal(mem[0]?.status, 'failed')
    assert.match(mem[0]?.detail ?? '', /EACCES/)
    assert.equal(mem[1]?.status, 'skipped')
    assert.equal(reports.find((r) => r.component === 'crewseb' && r.phase === 'install')?.status, 'done')
  })

  it('exec throwing a non-Error value is stringified', async () => {
    const reports = await runInstall(
      {
        locate: (b) => (b === 'npm' ? '/bin/npm' : null),
        exec: async () => {
          throw 'boom'
        },
      },
      { components: ['deckseb'], hosts: ['claude'] },
    )
    assert.equal(reports[0]?.detail, 'boom')
  })

  it('component without setup emits one step and total counts it once', async () => {
    const seen: number[] = []
    const reports = await runInstall(
      { locate: () => '/bin/x', exec: async () => out('') },
      {
        components: ['herdr-nvim-watcher'],
        hosts: ['claude'],
        onStep: (_r, _i, total) => seen.push(total),
      },
    )
    assert.equal(reports.length, 1)
    assert.deepEqual(seen, [1])
    assert.equal(reports[0]?.phase, 'install')
  })

  it('component without setup and missing requirement emits a single skipped step', async () => {
    const reports = await runInstall(
      { locate: () => null, exec: async () => out('') },
      { components: ['herdr-nvim-watcher'], hosts: ['claude'] },
    )
    assert.equal(reports.length, 1)
    assert.equal(reports[0]?.status, 'skipped')
  })

  it('empty component list yields no reports', async () => {
    assert.deepEqual(await runInstall({ locate: () => null, exec: async () => out('') }, { components: [], hosts: [] }), [])
  })
})

describe('normalizeConfig edge cases', () => {
  it('orchestrator outside hosts falls back to first host', () => {
    const c = normalizeConfig({ hosts: ['claude'], orchestrator: 'antigravity' })
    assert.equal(c.orchestrator, 'claude')
    const d = normalizeConfig({ hosts: ['antigravity'], orchestrator: 'claude' })
    assert.equal(d.orchestrator, 'antigravity')
  })

  it('invalid orchestrator with valid hosts uses first host; hosts deduped', () => {
    const c = normalizeConfig({ hosts: ['antigravity', 'antigravity', 'bogus'], orchestrator: 42 })
    assert.deepEqual(c.hosts, ['antigravity'])
    assert.equal(c.orchestrator, 'antigravity')
  })

  it('non-object / array / null inputs yield defaults; bad contextWindow entries dropped', () => {
    for (const raw of [null, undefined, 'x', 5]) assert.equal(normalizeConfig(raw).schema, 'sebshell-config/v1')
    const c = normalizeConfig({ contextWindow: { claude: -1, antigravity: Number.NaN, other: 5 } })
    assert.deepEqual(c.contextWindow, {})
  })

  it('contextWindow Infinity is rejected', () => {
    assert.deepEqual(normalizeConfig({ contextWindow: { claude: Infinity } }).contextWindow, {})
  })
})

describe('dispatch edge cases', () => {
  const req = { host: 'claude', prompt: 'hi' } as const

  it('claude is_error true with exit 0 is a failure carrying the result text', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: 'Credit balance too low', usage: { input_tokens: 1 } })
    const r = parseTurnOutput(req, out(stdout, 0))
    assert.equal(r.ok, false)
    assert.equal(r.error, 'Credit balance too low')
  })

  it('claude is_error true with empty result and exit 0 falls back to stderr then exit code', () => {
    const stdout = JSON.stringify({ type: 'result', is_error: true, result: '' })
    assert.equal(parseTurnOutput(req, out(stdout, 0, ' bad auth \n')).error, 'bad auth')
    assert.equal(parseTurnOutput(req, out(stdout, 0)).error, 'exit 0')
  })

  it('claude exit 0 with unparseable stdout is a failure', () => {
    const r = parseTurnOutput(req, out('garbage', 0))
    assert.equal(r.ok, false)
    assert.equal(r.text, '')
    assert.equal(r.context, null)
  })

  it('runTurn surfaces exec rejection as a failed turn', async () => {
    const r = await runTurn({ locate: () => '/bin/claude', exec: async () => Promise.reject(new Error('ENOENT')) }, req)
    assert.equal(r.ok, false)
    assert.equal(r.error, 'ENOENT')
  })
})
