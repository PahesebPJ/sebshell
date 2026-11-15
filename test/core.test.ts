import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { SystemRuntime } from 'hubseb'
import { configFile, defaultConfig, loadConfig, normalizeConfig, saveConfig } from '../src/config.ts'
import { buildInvocation, parseTurnOutput, runTurn } from '../src/dispatch.ts'
import { runInstall } from '../src/installer.ts'
import { orderComponents } from '../src/manifest.ts'
import { parseShellLine } from '../src/shell.ts'
import { formatTokens, lastJsonObject, parseAgyResult, parseClaudeResult } from '../src/usage.ts'
import { type Ask, runWizard } from '../src/wizard.ts'

// Captured from `claude -p --output-format json` (trimmed) and `agy -p --output-format json|stream-json`.
const CLAUDE_RESULT = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'ok',
  session_id: '514262ab-8772-4e3d-9b6f-1bcb609f5a3a',
  usage: {
    input_tokens: 2,
    cache_creation_input_tokens: 14678,
    cache_read_input_tokens: 9002,
    output_tokens: 4,
    iterations: [{ input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 9002, cache_creation_input_tokens: 14678 }],
  },
  modelUsage: { 'claude-haiku-5-5': { contextWindow: 1_000_000, maxOutputTokens: 128000 } },
}
const AGY_JSON = {
  conversation_id: 'ddfa0f46-ff49-4f30-9884-12364afbf7c3',
  status: 'SUCCESS',
  response: 'ok\n',
  usage: { input_tokens: 14252, output_tokens: 49, thinking_tokens: 44, cache_read_tokens: 0, total_tokens: 14301 },
}
const AGY_STREAM = [
  '{"event":"step_update","step_update":{"conversation_id":"47bd","state":"ACTIVE","text_delta":"ok"}}',
  '{"event":"result","result":{"conversation_id":"47bd","status":"SUCCESS","response":"ok\\n","usage":{"input_tokens":14255,"cache_read_tokens":100}}}',
].join('\n')

describe('usage parsing', () => {
  it('computes claude context from the last iteration and model window', () => {
    const snap = parseClaudeResult(CLAUDE_RESULT)
    assert.deepEqual(snap, {
      host: 'claude',
      usedTokens: 2 + 9002 + 14678,
      windowTokens: 1_000_000,
      sessionId: '514262ab-8772-4e3d-9b6f-1bcb609f5a3a',
      model: 'claude-haiku-5-5',
    })
  })

  it('falls back to configured window when claude omits modelUsage', () => {
    const { modelUsage: _drop, ...rest } = CLAUDE_RESULT
    assert.equal(parseClaudeResult(rest, 123)?.windowTokens, 123)
    assert.equal(parseClaudeResult(rest)?.windowTokens, 200_000)
    assert.equal(parseClaudeResult({ type: 'assistant' }), null)
  })

  it('parses agy json and the result event of stream-json', () => {
    assert.equal(parseAgyResult(AGY_JSON)?.usedTokens, 14252)
    assert.equal(parseAgyResult(AGY_JSON)?.windowTokens, 1_000_000)
    const streamed = parseAgyResult(lastJsonObject(AGY_STREAM))
    assert.equal(streamed?.usedTokens, 14355)
    assert.equal(streamed?.sessionId, '47bd')
    assert.equal(parseAgyResult({ foo: 1 }), null)
  })

  it('formats token counts compactly', () => {
    assert.equal(formatTokens(950), '950')
    assert.equal(formatTokens(136_400), '136k')
    assert.equal(formatTokens(1_000_000), '1M')
    assert.equal(formatTokens(1_500_000), '1.5M')
  })
})

describe('dispatch', () => {
  it('builds native invocations per host, with agent and resume flags', () => {
    assert.deepEqual(buildInvocation({ host: 'claude', prompt: 'hola', agent: 'developer', sessionId: 's1' }), {
      bin: 'claude',
      args: ['-p', 'hola', '--output-format', 'json', '--agent', 'developer', '--resume', 's1'],
    })
    assert.deepEqual(buildInvocation({ host: 'antigravity', prompt: 'hola', sessionId: 'c1' }), {
      bin: 'agy',
      args: ['-p', 'hola', '--output-format', 'json', '--conversation', 'c1'],
    })
  })

  it('parses successful and failed turns', () => {
    const ok = parseTurnOutput({ host: 'claude', prompt: 'x' }, { exitCode: 0, stdout: JSON.stringify(CLAUDE_RESULT), stderr: '' })
    assert.equal(ok.ok, true)
    assert.equal(ok.text, 'ok')
    const agyFail = parseTurnOutput(
      { host: 'antigravity', prompt: 'x' },
      { exitCode: 0, stdout: JSON.stringify({ ...AGY_JSON, status: 'ERROR' }), stderr: '' },
    )
    assert.equal(agyFail.ok, false)
    const crashed = parseTurnOutput({ host: 'claude', prompt: 'x' }, { exitCode: 1, stdout: '', stderr: 'boom' })
    assert.deepEqual([crashed.ok, crashed.error], [false, 'boom'])
  })

  it('reports a missing host binary without spawning', async () => {
    const res = await runTurn({ locate: () => null, exec: async () => assert.fail('must not exec') }, { host: 'antigravity', prompt: 'x' })
    assert.deepEqual([res.ok, res.error], [false, '"agy" no está instalado'])
  })
})

describe('installer', () => {
  it('orders components canonically regardless of selection order', () => {
    assert.deepEqual(orderComponents(['crewseb', 'memoseb']).map((c) => c.id), ['memoseb', 'crewseb'])
  })

  it('skips present binaries, runs setup with host flags, and isolates failures', async () => {
    const calls: string[] = []
    const present = new Set(['npm', 'memoseb', 'herdr'])
    const reports = await runInstall(
      {
        locate: (b) => (present.has(b) ? `/bin/${b}` : null),
        exec: async (bin, args) => {
          calls.push(`${path.basename(bin)} ${args.join(' ')}`)
          if (args.includes('crewseb')) return { exitCode: 1, stdout: '', stderr: 'E404 not found' }
          return { exitCode: 0, stdout: '', stderr: '' }
        },
      },
      { components: ['crewseb', 'memoseb', 'herdr-nvim-watcher'], hosts: ['claude', 'antigravity'] },
    )
    assert.deepEqual(calls, [
      'memoseb setup --agents claude,antigravity',
      'npm install -g crewseb',
    ])
    assert.deepEqual(
      reports.map((r) => `${r.component}:${r.phase}:${r.status}`),
      ['memoseb:install:skipped', 'memoseb:setup:done', 'crewseb:install:failed', 'crewseb:setup:skipped', 'herdr-nvim-watcher:install:skipped'],
    )
    assert.match(reports[2]?.detail ?? '', /E404/)
    assert.match(reports[4]?.detail ?? '', /requiere nvim/)
  })

  it('dry-run never executes commands', async () => {
    const reports = await runInstall(
      { locate: (b) => (b === 'deckseb' ? null : `/bin/${b}`), exec: async () => assert.fail('no exec') },
      { components: ['deckseb'], hosts: ['claude'], dryRun: true },
    )
    assert.ok(reports.every((r) => r.status === 'skipped'))
  })
})

describe('wizard', () => {
  it('walks all steps, supports going back, and returns the edited config', async () => {
    const answers: Array<{ id: string; res: Awaited<ReturnType<Ask>> }> = [
      { id: 'hosts', res: { kind: 'submitted', values: ['antigravity'] } },
      { id: 'components', res: { kind: 'back' } },
      { id: 'hosts', res: { kind: 'submitted', values: ['claude', 'antigravity'] } },
      { id: 'components', res: { kind: 'submitted', values: ['memoseb', 'crewseb'] } },
      { id: 'orchestrator', res: { kind: 'submitted', values: ['antigravity'] } },
      { id: 'modelPreset', res: { kind: 'submitted', values: ['cloud-tiered'] } },
      { id: 'theme', res: { kind: 'submitted', values: ['ember'] } },
      { id: 'confirm', res: { kind: 'submitted', values: ['save'] } },
    ]
    const seen: string[] = []
    const outcome = await runWizard(async (q) => {
      seen.push(q.id)
      const next = answers.shift()
      assert.equal(q.id, next?.id)
      return next!.res
    }, ['claude'])
    assert.equal(seen.length, 8)
    assert.equal(outcome.kind, 'apply')
    if (outcome.kind !== 'apply') return
    assert.equal(outcome.install, false)
    assert.deepEqual(outcome.config.hosts, ['claude', 'antigravity'])
    assert.equal(outcome.config.orchestrator, 'antigravity')
    assert.equal(outcome.config.modelPreset, 'cloud-tiered')
    assert.equal(outcome.config.theme, 'ember')
  })

  it('aborts on esc at the first step and on ctrl+c anywhere', async () => {
    assert.equal((await runWizard(async () => ({ kind: 'back' }), [])).kind, 'aborted')
    assert.equal((await runWizard(async () => ({ kind: 'aborted' }), [])).kind, 'aborted')
  })

  it('only offers chosen hosts as orchestrator', async () => {
    let orchestratorOptions: string[] = []
    await runWizard(async (q) => {
      if (q.id === 'hosts') return { kind: 'submitted', values: ['antigravity'] }
      if (q.id === 'orchestrator') {
        orchestratorOptions = q.options.map((o) => o.value)
        return { kind: 'aborted' }
      }
      return { kind: 'submitted', values: q.initial }
    }, [])
    assert.deepEqual(orchestratorOptions, ['antigravity'])
  })
})

describe('config', () => {
  it('normalizes invalid values back to defaults', () => {
    const c = normalizeConfig({ hosts: ['codex', 'antigravity'], orchestrator: 'claude', theme: 'neon', contextWindow: { claude: -1, antigravity: 500 } })
    assert.deepEqual(c.hosts, ['antigravity'])
    assert.equal(c.orchestrator, 'antigravity')
    assert.equal(c.theme, 'aurora')
    assert.deepEqual(c.contextWindow, { antigravity: 500 })
    assert.deepEqual(normalizeConfig(null).hosts, defaultConfig().hosts)
  })

  it('round-trips through disk under HUBSEB_HOME and tolerates corruption', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'sebshell-cfg-'))
    try {
      const runtime = new SystemRuntime({ env: { HUBSEB_HOME: dir } })
      assert.equal(await loadConfig(runtime), null)
      const file = await saveConfig(runtime, { ...defaultConfig(), theme: 'mono' })
      assert.equal(file, configFile(runtime))
      assert.equal((await loadConfig(runtime))?.theme, 'mono')
      await writeFile(file, '{not json', 'utf8')
      assert.equal(await loadConfig(runtime), null)
      assert.match(await readFile(file, 'utf8'), /not json/)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

describe('shell line parser', () => {
  it('parses prompts and colon commands with aliases', () => {
    assert.deepEqual(parseShellLine('  arregla el bug '), { kind: 'prompt', text: 'arregla el bug' })
    assert.deepEqual(parseShellLine(':host agy'), { kind: 'host', host: 'antigravity', raw: 'agy' })
    assert.deepEqual(parseShellLine(':h nope'), { kind: 'host', host: null, raw: 'nope' })
    assert.deepEqual(parseShellLine(':agent researcher'), { kind: 'agent', agent: 'researcher' })
    assert.deepEqual(parseShellLine(':agent none'), { kind: 'agent', agent: null })
    assert.equal(parseShellLine(':q').kind, 'exit')
    assert.equal(parseShellLine('').kind, 'empty')
    assert.equal(parseShellLine(':wat').kind, 'unknown')
  })
})
