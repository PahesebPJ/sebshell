import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { beginActivity, listActivity, newSessionId, SESSION_ENV } from '../src/activity.ts'
import { defaultConfig } from '../src/config.ts'
import type { DispatchDeps } from '../src/dispatch.ts'
import { delegate, type McpDeps } from '../src/mcp.ts'
import { runShell } from '../src/shell.ts'

const roots: string[] = []
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sebshell-activity-edge-'))
  roots.push(dir)
  return path.join(dir, 'active')
}

const okOutput = { exitCode: 0, stdout: JSON.stringify({ type: 'result', result: 'ok', session_id: 's', usage: { input_tokens: 1 } }), stderr: '' }

function mcpDeps(over: Partial<McpDeps> = {}, events: string[] = []): McpDeps {
  return {
    crew: { role: async () => undefined, roles: async () => [] } as unknown as McpDeps['crew'],
    dispatch: { locate: (b) => `/bin/${b}`, exec: async () => okOutput },
    profileEnv: async () => ({}),
    permission: async () => 'default',
    enabledHosts: async () => ['claude', 'antigravity'],
    env: { SEBSHELL_CALLER: 'claude' },
    cwd: '/tmp',
    activity: async (label) => {
      events.push(`begin ${label}`)
      return async () => {
        events.push('end')
      }
    },
    ...over,
  }
}

describe('activity hook: early rejections never register', () => {
  const cases: Array<[string, Partial<McpDeps>, Record<string, unknown>]> = [
    ['non-crew role', {}, { agent: 'rm -rf', prompt: 'x' }],
    ['empty prompt', {}, { agent: 'developer', prompt: '   ' }],
    ['oversized prompt', {}, { agent: 'developer', prompt: 'x'.repeat(10 * 1024 * 1024) }],
    ['invalid host', {}, { agent: 'developer', prompt: 'x', host: 'emacs' }],
    ['depth limit', { env: { SEBSHELL_CALLER: 'claude', SEBSHELL_DELEGATION_DEPTH: '99' } }, { agent: 'developer', prompt: 'x' }],
    ['disabled host', { enabledHosts: async () => ['claude'] }, { agent: 'developer', prompt: 'x', host: 'antigravity' }],
    ['profile failure', { profileEnv: async () => Promise.reject(new Error('no profile')) }, { agent: 'developer', prompt: 'x' }],
    ['cwd escape', {}, { agent: 'developer', prompt: 'x', cwd: '/etc' }],
  ]
  for (const [name, over, args] of cases) {
    it(name, async () => {
      const events: string[] = []
      const res = await delegate(mcpDeps(over, events), args)
      assert.equal(res.isError, true)
      assert.deepEqual(events, [])
    })
  }
})

describe('activity hook: cleanup on abort', () => {
  it('clears the record when the caller signal aborts mid-turn', async () => {
    const events: string[] = []
    const ac = new AbortController()
    const deps = mcpDeps(
      {
        dispatch: {
          locate: (b) => `/bin/${b}`,
          exec: (_b, _a, opts) =>
            new Promise((_res, rej) => {
              opts.signal?.addEventListener('abort', () => rej(new Error('aborted')))
            }),
        },
      },
      events,
    )
    const p = delegate(deps, { agent: 'developer', prompt: 'x' }, ac.signal)
    await new Promise((r) => setTimeout(r, 20))
    assert.deepEqual(events, ['begin claude:developer'])
    ac.abort()
    await p
    assert.deepEqual(events, ['begin claude:developer', 'end'])
  })

  it('clears the record when the timeout fires', async () => {
    const events: string[] = []
    const deps = mcpDeps(
      {
        timeoutMs: 30,
        dispatch: {
          locate: (b) => `/bin/${b}`,
          exec: (_b, _a, opts) =>
            new Promise((_res, rej) => {
              opts.signal?.addEventListener('abort', () => rej(new Error('timeout')))
            }),
        },
      },
      events,
    )
    await delegate(deps, { agent: 'developer', prompt: 'x' })
    assert.deepEqual(events, ['begin claude:developer', 'end'])
  })

  it('does not fail the delegation when the activity hook itself rejects (the bar is cosmetic)', async () => {
    const deps = mcpDeps({ activity: async () => Promise.reject(new Error('disk full')) })
    const res = await delegate(deps, { agent: 'developer', prompt: 'x' })
    assert.notEqual(res.isError, true)
  })

  it('is balanced under concurrent delegations: one end per begin', async () => {
    const events: string[] = []
    const deps = mcpDeps({}, events)
    await Promise.all([1, 2, 3, 4].map(() => delegate(deps, { agent: 'developer', prompt: 'x' })))
    assert.equal(events.filter((e) => e.startsWith('begin')).length, 4)
    assert.equal(events.filter((e) => e === 'end').length, 4)
  })
})

describe('registry edge cases', () => {
  it('concurrent begins yield distinct files, even with the same pid and label', async () => {
    const dir = await tmp()
    const session = newSessionId()
    const ends = await Promise.all(Array.from({ length: 25 }, () => beginActivity(dir, session, 'same')))
    assert.equal((await readdir(dir)).length, 25)
    assert.equal((await listActivity(dir, session)).length, 25)
    await ends[0]!()
    assert.equal((await readdir(dir)).length, 24)
    await Promise.all(ends.map((e) => e()))
    assert.deepEqual(await readdir(dir), [])
  })

  it('end is idempotent', async () => {
    const dir = await tmp()
    const end = await beginActivity(dir, newSessionId(), 'x')
    await end()
    await end()
  })

  it('orders by startedAt, independent of file name or readdir order', async () => {
    const dir = await tmp()
    const session = newSessionId()
    const rec = (label: string, startedAt: string) => JSON.stringify({ session, pid: process.pid, label, startedAt })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(dir, `${session}-a.json`), rec('third', '2026-01-01T00:00:03.000Z'))
    await writeFile(path.join(dir, `${session}-b.json`), rec('first', '2026-01-01T00:00:01.000Z'))
    await writeFile(path.join(dir, `${session}-c.json`), rec('second', '2026-01-01T00:00:02.000Z'))
    assert.deepEqual(await listActivity(dir, session), ['first', 'second', 'third'])
  })

  it('tolerates records without startedAt and non-string labels', async () => {
    const dir = await tmp()
    const session = newSessionId()
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dir, { recursive: true, mode: 0o700 })
    await writeFile(path.join(dir, `${session}-a.json`), JSON.stringify({ session, pid: process.pid, label: 'nodate' }))
    await writeFile(path.join(dir, `${session}-b.json`), JSON.stringify({ session, pid: process.pid, label: 42 }))
    await writeFile(path.join(dir, `${session}-c.json`), JSON.stringify({ session, pid: 1.5, label: 'float-pid' }))
    await writeFile(path.join(dir, `${session}-d.json`), 'null')
    await writeFile(path.join(dir, 'e.txt'), 'ignored')
    assert.deepEqual(await listActivity(dir, session), ['nodate'])
  })

  it('truncates long labels to 80 characters on write', async () => {
    const dir = await tmp()
    const session = newSessionId()
    await beginActivity(dir, session, 'y'.repeat(500))
    const [label] = await listActivity(dir, session)
    assert.equal(label!.length, 80)
  })

  it('returns an empty list for a missing directory', async () => {
    assert.deepEqual(await listActivity(path.join(await tmp(), 'nope'), newSessionId()), [])
  })

  it('prunes records older than 24h even when their pid is alive (pid reuse)', async () => {
    const dir = await tmp()
    const session = newSessionId()
    await beginActivity(dir, session, 'old')
    const [file] = await readdir(dir)
    const past = new Date(Date.now() - 7 * 24 * 3600 * 1000)
    await utimes(path.join(dir, file!), past, past)
    assert.deepEqual(await listActivity(dir, session), [])
    assert.deepEqual(await readdir(dir), [])
  })
})

describe('session env reaches the delegated child', () => {
  it('SEBSHELL_SESSION_ID in the mcp process env survives scrubSecrets into the child env', async () => {
    const session = newSessionId()
    const prev = process.env[SESSION_ENV]
    process.env[SESSION_ENV] = session
    let seen: NodeJS.ProcessEnv | undefined
    try {
      const { runTurn } = await import('../src/dispatch.ts')
      await runTurn(
        { locate: (b) => `/bin/${b}`, exec: async (_b, _a, o) => ((seen = o.env), okOutput) },
        { host: 'claude', prompt: 'x', agent: 'developer', model: null, effort: null, sessionId: null, permission: 'default', cwd: '/tmp', env: { X: '1' }, scrubSecrets: true } as never,
      )
    } finally {
      if (prev === undefined) delete process.env[SESSION_ENV]
      else process.env[SESSION_ENV] = prev
    }
    assert.equal(seen?.[SESSION_ENV], session)
  })
})

function shellIO() {
  const input = new PassThrough()
  const output = Object.assign(new PassThrough(), { isTTY: true, rows: 24, columns: 240 })
  const chunks: string[] = []
  output.on('data', (c: Buffer) => chunks.push(c.toString()))
  return {
    input,
    io: { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, color: false },
    text: () => chunks.join(''),
  }
}

describe('shell polling edge cases', () => {
  it('a poll that resolves after the turn ended does not re-add labels; the bar ends at sub 0', async () => {
    const { input, io, text } = shellIO()
    const config = { ...defaultConfig(), orchestrator: 'claude' as const, hosts: ['claude' as const] }
    let calls = 0
    const dispatch: DispatchDeps = {
      locate: (b) => `/bin/${b}`,
      exec: async () => {
        await new Promise((r) => setTimeout(r, 1300))
        return okOutput
      },
    }
    const done = runShell(
      io,
      config,
      {
        dispatch,
        services: async () => [],
        reconfigure: async () => null,
        // First poll lands at ~1000ms and resolves at ~1600ms, after the turn ended (~1300ms).
        activity: async () => {
          calls++
          await new Promise((r) => setTimeout(r, 600))
          return ['agy:LATE']
        },
        profiles: { active: async () => 'default', names: async () => ['default'], env: async () => ({}) },
      },
      'test',
    )
    input.write('hola\n')
    await new Promise((r) => setTimeout(r, 2200))
    const out = text()
    input.write(':exit\n')
    input.end()
    await done
    assert.ok(calls >= 1)
    assert.doesNotMatch(out, /LATE/)
    const bars = [...out.matchAll(/sub \d+/g)].map((m) => m[0])
    assert.equal(bars.at(-1), 'sub 0')
  })

  it('a rejecting activity service neither breaks the turn nor stops later polls', async () => {
    const { input, io, text } = shellIO()
    const config = { ...defaultConfig(), orchestrator: 'claude' as const, hosts: ['claude' as const] }
    let calls = 0
    const dispatch: DispatchDeps = {
      locate: (b) => `/bin/${b}`,
      exec: async () => {
        await new Promise((r) => setTimeout(r, 2300))
        return okOutput
      },
    }
    const done = runShell(
      io,
      config,
      {
        dispatch,
        services: async () => [],
        reconfigure: async () => null,
        activity: async () => {
          calls++
          if (calls === 1) throw new Error('fs down')
          return ['agy:recovered']
        },
        profiles: { active: async () => 'default', names: async () => ['default'], env: async () => ({}) },
      },
      'test',
    )
    input.write('hola\n')
    await new Promise((r) => setTimeout(r, 2700))
    const out = text()
    input.write(':exit\n')
    input.end()
    await done
    assert.ok(calls >= 2, `polling continued after a rejection (calls=${calls})`)
    assert.match(out, /agy:recovered/)
  })

  it('does not poll when the turn finishes before the first tick', async () => {
    const { input, io } = shellIO()
    const config = { ...defaultConfig(), orchestrator: 'claude' as const, hosts: ['claude' as const] }
    let calls = 0
    const done = runShell(
      io,
      config,
      {
        dispatch: { locate: (b) => `/bin/${b}`, exec: async () => okOutput },
        services: async () => [],
        reconfigure: async () => null,
        activity: async () => {
          calls++
          return []
        },
        profiles: { active: async () => 'default', names: async () => ['default'], env: async () => ({}) },
      },
      'test',
    )
    input.write('hola\n')
    await new Promise((r) => setTimeout(r, 1600))
    input.write(':exit\n')
    input.end()
    await done
    assert.equal(calls, 0, 'the interval is cleared once the turn ends')
  })
})
