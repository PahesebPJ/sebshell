import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { CrewClient, type CrewRoleInfo } from '../src/crew.ts'
import { agyModelArgs, buildInvocation, type DispatchDeps } from '../src/dispatch.ts'
import { DEPTH_ENV, delegate, handleMcpRequest, type McpDeps } from '../src/mcp.ts'

const saved = { ...process.env }
let sandbox = ''
before(() => {
  sandbox = mkdtempSync(path.join(os.tmpdir(), 'sebshell-crew-edge-'))
  process.env.HOME = sandbox
  process.env.HUBSEB_HOME = path.join(sandbox, '.hubseb')
  process.env.CREWSEB_MODELS_FILE = path.join(sandbox, 'models.json')
})
after(() => {
  for (const k of ['HOME', 'HUBSEB_HOME', 'CREWSEB_MODELS_FILE']) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(sandbox, { recursive: true, force: true })
})

const wire = (payload: unknown) => `${JSON.stringify({ protocol: 'hubseb/v1', status: 'success', action: 'x', ts: 0, payload })}\n`
const developer: CrewRoleInfo = {
  role: 'developer',
  tier: 'deep',
  runsOn: null,
  hosts: { claude: { model: 'opus', native: 'opus', effort: 'high', appliedAt: 'frontmatter' } },
}

function client(rolesPayload: unknown) {
  let calls = 0
  const c = new CrewClient({
    locate: () => '/bin/crewseb',
    exec: async () => {
      calls++
      return { exitCode: 0, stdout: wire({ roles: rolesPayload }), stderr: '' }
    },
  })
  return { c, calls: () => calls }
}

interface Spawned {
  bin?: string
  args?: readonly string[]
  env?: NodeJS.ProcessEnv
  count: number
}

function mcpDeps(overrides: Partial<McpDeps> = {}, spawned: Spawned = { count: 0 }): McpDeps {
  const dispatch: DispatchDeps = {
    locate: (b) => `/bin/${b}`,
    exec: async (bin, args, opts) => {
      spawned.count++
      spawned.bin = bin
      spawned.args = args
      spawned.env = opts.env
      return { exitCode: 0, stdout: JSON.stringify({ type: 'result', result: 'ok', status: 'SUCCESS', response: 'ok' }), stderr: '' }
    },
  }
  return { crew: client([developer]).c, dispatch, profileEnv: async () => ({}), permission: async () => 'default', enabledHosts: async () => ['claude', 'antigravity'], env: {}, cwd: sandbox || '/tmp', ...overrides }
}

describe('agyModelArgs edge cases', () => {
  it('keeps a model whose trailing segment is not an effort level, even with --effort', () => {
    assert.deepEqual(agyModelArgs('gemini-pro-orchestrator-g1-pro', 'high'), ['--model', 'gemini-pro-orchestrator-g1-pro', '--effort', 'high'])
    assert.deepEqual(agyModelArgs('gemini-4-turbo', 'low'), ['--model', 'gemini-4-turbo', '--effort', 'low'])
  })

  it('does not strip a suffix that merely contains an effort word', () => {
    assert.deepEqual(agyModelArgs('model-highest', 'low'), ['--model', 'model-highest', '--effort', 'low'])
    assert.deepEqual(agyModelArgs('model-xhigh2', 'low'), ['--model', 'model-xhigh2', '--effort', 'low'])
  })

  it('keeps the suffix when no explicit effort is given and strips it when one is', () => {
    assert.deepEqual(agyModelArgs('gemini-4-hydrogen-xhigh', null), ['--model', 'gemini-4-hydrogen-xhigh'])
    assert.deepEqual(agyModelArgs('gemini-4-hydrogen-xhigh', 'low'), ['--model', 'gemini-4-hydrogen', '--effort', 'low'])
  })

  it('returns no args for empty inputs and a lone effort has no model', () => {
    assert.deepEqual(agyModelArgs(null, null), [])
    assert.deepEqual(agyModelArgs('', undefined), [])
    assert.deepEqual(agyModelArgs(undefined, 'max'), ['--effort', 'max'])
  })

  it('a bare effort word is not split (needs a non-empty base)', () => {
    assert.deepEqual(agyModelArgs('high', 'low'), ['--model', 'high', '--effort', 'low'])
  })
})

describe('buildInvocation edge cases', () => {
  it('puts an agy prompt starting with "-" right after -p, never on stdin', () => {
    for (const prompt of ['-rf /', '--help', '-', '--model evil']) {
      const inv = buildInvocation({ host: 'antigravity', prompt, agent: 'developer', model: 'gemini-4-hydrogen', effort: 'low' })
      assert.equal(inv.args[0], '-p')
      assert.equal(inv.args[1], prompt)
      assert.equal(inv.args.filter((a) => a === '-p').length, 1)
      assert.equal(inv.input, undefined)
    }
  })

  it('sends a claude prompt starting with "-" through stdin only', () => {
    const inv = buildInvocation({ host: 'claude', prompt: '--dangerously-skip-permissions' })
    assert.equal(inv.input, '--dangerously-skip-permissions')
    assert.ok(!inv.args.includes('--dangerously-skip-permissions'))
  })

  it('rejects hostile agent, session and model names', () => {
    assert.throws(() => buildInvocation({ host: 'antigravity', prompt: 'x', agent: '--x' }), /agente inválido/)
    assert.throws(() => buildInvocation({ host: 'antigravity', prompt: 'x', sessionId: 'a b' }), /sesión/)
    assert.throws(() => buildInvocation({ host: 'antigravity', prompt: 'x', model: '-m' }), /modelo inválido/)
    assert.throws(() => buildInvocation({ host: 'claude', prompt: 'x', effort: 'turbo' as never }), /Esfuerzo inválido/)
  })
})

describe('delegate edge cases', () => {
  it('rejects empty and whitespace-only prompts without spawning', async () => {
    const sp: Spawned = { count: 0 }
    for (const prompt of ['', '   ', '\n\t ', undefined, 42, null]) {
      const res = await delegate(mcpDeps({}, sp), { agent: 'developer', prompt })
      assert.equal((res as { isError?: boolean }).isError, true, String(prompt))
    }
    assert.equal(sp.count, 0)
  })

  it('rejects agents with spaces or flag-like names and non-string agents', async () => {
    const sp: Spawned = { count: 0 }
    for (const agent of ['code reviewer', 'dev; rm', '--agent', '', '   ', undefined, 7, ['developer']]) {
      const res = await delegate(mcpDeps({}, sp), { agent, prompt: 'x' })
      assert.equal((res as { isError?: boolean }).isError, true, String(agent))
    }
    assert.equal(sp.count, 0)
  })

  it('trims surrounding whitespace from the agent name', async () => {
    const sp: Spawned = { count: 0 }
    const res = await delegate(mcpDeps({}, sp), { agent: '  developer  ', prompt: 'x' })
    assert.equal((res as { isError?: boolean }).isError, undefined)
    assert.equal(sp.args?.[sp.args.indexOf('--agent') + 1], 'developer')
  })

  it('fails closed on a non-numeric depth, and treats an empty one as the root', async () => {
    for (const raw of ['abc', 'NaN', ' ', 'Infinity']) {
      const sp: Spawned = { count: 0 }
      const res = await delegate(mcpDeps({ env: { [DEPTH_ENV]: raw } }, sp), { agent: 'developer', prompt: 'x' })
      assert.equal((res as { isError?: boolean }).isError, true, raw)
      assert.equal(sp.count, 0, raw)
    }
    const sp: Spawned = { count: 0 }
    await delegate(mcpDeps({ env: { [DEPTH_ENV]: '' } }, sp), { agent: 'developer', prompt: 'x' })
    assert.equal(sp.env?.[DEPTH_ENV], '1')
  })

  it('refuses at the depth limit, including numeric strings with trailing junk', async () => {
    const sp: Spawned = { count: 0 }
    for (const raw of ['2', '3', '99', '2abc', '2.9']) {
      const res = await delegate(mcpDeps({ env: { [DEPTH_ENV]: raw } }, sp), { agent: 'developer', prompt: 'x' })
      assert.equal((res as { isError?: boolean }).isError, true, raw)
    }
    assert.equal(sp.count, 0)
  })

  it('a negative depth is rejected instead of letting a child restart the chain below zero', async () => {
    const sp: Spawned = { count: 0 }
    const res = await delegate(mcpDeps({ env: { [DEPTH_ENV]: '-5' } }, sp), { agent: 'developer', prompt: 'x' })
    assert.equal((res as { isError?: boolean }).isError, true)
    assert.equal(sp.count, 0)
  })

  it('does not throw when a crewseb role entry has no hosts map', async () => {
    const broken = { role: 'developer', tier: 'deep', runsOn: null } as unknown as CrewRoleInfo
    const res = await delegate(mcpDeps({ crew: client([broken]).c }), { agent: 'developer', prompt: 'x' })
    assert.equal((res as { isError?: boolean }).isError, undefined)
  })
})

describe('handleMcpRequest edge cases', () => {
  it('answers an unknown method with -32601 and echoes the id', async () => {
    const res = await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: 'abc', method: 'resources/list' }, '1')
    assert.deepEqual(res, { jsonrpc: '2.0', id: 'abc', error: { code: -32601, message: 'Method not found: resources/list' } })
  })

  it('answers a missing or non-string method with -32601 instead of crashing', async () => {
    const noMethod = await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: 1 }, '1')
    assert.equal((noMethod?.error as { code: number }).code, -32601)
    const numeric = await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: 2, method: 5 }, '1')
    assert.equal((numeric?.error as { code: number }).code, -32601)
  })

  it('returns null for notifications and for requests without id; id 0 and null still answer', async () => {
    assert.equal(await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', method: 'ping' }, '1'), null)
    assert.equal(await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: 1, method: 'notifications/initialized' }, '1'), null)
    assert.deepEqual(await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: 0, method: 'ping' }, '1'), { jsonrpc: '2.0', id: 0, result: {} })
    assert.equal((await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: null, method: 'ping' }, '1'))?.id, null)
  })

  it('answers tools/call of a nonexistent tool with -32602 and never spawns', async () => {
    const sp: Spawned = { count: 0 }
    const res = await handleMcpRequest(mcpDeps({}, sp), { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'seb_nope', arguments: { agent: 'developer', prompt: 'x' } } }, '1')
    assert.deepEqual(res?.error, { code: -32602, message: 'Unknown tool: seb_nope' })
    assert.equal(sp.count, 0)
  })

  it('handles tools/call with missing params, non-object params or null arguments', async () => {
    for (const params of [undefined, null, 'x', 5, {}, { name: 'seb_delegate' }, { name: 'seb_delegate', arguments: null }, { name: 'seb_delegate', arguments: 'str' }]) {
      const res = await handleMcpRequest(mcpDeps(), { jsonrpc: '2.0', id: 4, method: 'tools/call', params }, '1')
      assert.ok(res, JSON.stringify(params))
      const isErr = Boolean(res?.error) || (res?.result as { isError?: boolean }).isError === true
      assert.ok(isErr, JSON.stringify(params))
    }
  })

  it('seb_routing reports crewseb failure as a tool error, not a protocol error', async () => {
    const failing = new CrewClient({ locate: () => null, exec: async () => assert.fail('no exec') })
    const res = await handleMcpRequest(mcpDeps({ crew: failing }), { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'seb_routing' } }, '1')
    assert.equal((res?.result as { isError?: boolean }).isError, true)
  })
})

describe('CrewClient edge cases', () => {
  it('filters roles that are not crew roles', async () => {
    const { c } = client([developer, { ...developer, role: 'hacker' }, { ...developer, role: 42 }, { ...developer, role: 'Developer' }])
    const roles = await c.roles()
    assert.deepEqual(roles.map((r) => r.role), ['developer'])
    assert.equal(await c.role('developer').then((r) => r?.role), 'developer')
  })

  it('returns an empty list when every role is invalid', async () => {
    assert.deepEqual(await client([{ role: 'x' }]).c.roles(), [])
    assert.deepEqual(await client([]).c.roles(), [])
  })

  it('ignores null or non-object entries in the roles array', async () => {
    const roles = await client([null, 'developer', 3, developer]).c.roles()
    assert.deepEqual(roles.map((r) => r.role), ['developer'])
  })

  it('caches for 5s, expires at exactly 5000ms, and force bypasses the cache', async (t) => {
    let now = 1_000_000
    t.mock.method(Date, 'now', () => now)
    const { c, calls } = client([developer])
    await c.roles()
    await c.roles()
    await c.role('developer')
    assert.equal(calls(), 1)
    now += 4999
    await c.roles()
    assert.equal(calls(), 1)
    now += 1
    await c.roles()
    assert.equal(calls(), 2, 'expired at the 5000ms boundary')
    await c.roles(true)
    assert.equal(calls(), 3)
  })

  it('a mutation invalidates the cache', async (t) => {
    t.mock.method(Date, 'now', () => 1_000_000)
    const { c, calls } = client([developer])
    await c.roles()
    await c.route('developer', null)
    await c.roles()
    assert.equal(calls(), 3, 'resolve, route, resolve again')
  })

  it('does not cache a failed call', async (t) => {
    t.mock.method(Date, 'now', () => 1_000_000)
    let n = 0
    const c = new CrewClient({
      locate: () => '/bin/crewseb',
      exec: async () => (++n === 1 ? { exitCode: 1, stdout: 'boom', stderr: 'bad' } : { exitCode: 0, stdout: wire({ roles: [developer] }), stderr: '' }),
    })
    await assert.rejects(c.roles(), /hubseb\/v1/)
    assert.equal((await c.roles()).length, 1)
  })
})
