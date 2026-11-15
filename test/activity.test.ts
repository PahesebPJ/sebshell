import assert from 'node:assert/strict'
import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { after, describe, it } from 'node:test'
import { activityDir, beginActivity, isSessionId, listActivity, newSessionId, SESSION_ENV } from '../src/activity.ts'
import { defaultConfig } from '../src/config.ts'
import type { DispatchDeps } from '../src/dispatch.ts'
import { delegate, type McpDeps } from '../src/mcp.ts'
import { runShell } from '../src/shell.ts'

const roots: string[] = []
after(async () => {
  for (const r of roots) await rm(r, { recursive: true, force: true })
})
async function tmp(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sebshell-activity-'))
  roots.push(dir)
  return path.join(dir, 'active')
}

/** A pid that is guaranteed not to exist (beyond the kernel's pid_max). */
const DEAD_PID = 2 ** 22 + 1

describe('activity registry', () => {
  it('resolves the directory from XDG_RUNTIME_DIR, falling back to ~/.local/state', () => {
    assert.equal(activityDir({ XDG_RUNTIME_DIR: '/run/user/1000' }, '/home/u'), '/run/user/1000/sebshell/active')
    assert.equal(activityDir({}, '/home/u'), '/home/u/.local/state/sebshell/active')
    assert.equal(activityDir({ XDG_RUNTIME_DIR: 'relative' }, '/home/u'), '/home/u/.local/state/sebshell/active')
  })

  it('lists a live record for its session and removes it on end', async () => {
    const dir = await tmp()
    const session = newSessionId()
    const end = await beginActivity(dir, session, 'agy:researcher · pro')
    assert.deepEqual(await listActivity(dir, session), ['agy:researcher · pro'])
    assert.equal((await stat(dir)).mode & 0o777, 0o700)
    const [file] = await readdir(dir)
    assert.equal((await stat(path.join(dir, file!))).mode & 0o777, 0o600)
    await end()
    assert.deepEqual(await listActivity(dir, session), [])
    assert.deepEqual(await readdir(dir), [])
  })

  it('hides other sessions and prunes records of dead processes', async () => {
    const dir = await tmp()
    const mine = newSessionId()
    const other = newSessionId()
    await beginActivity(dir, other, 'claude:developer')
    await beginActivity(dir, mine, 'claude:architect', DEAD_PID)
    assert.deepEqual(await listActivity(dir, mine), [])
    assert.equal((await readdir(dir)).length, 1, 'the dead record is deleted, the live one of another session is kept')
  })

  it('ignores invalid sessions, oversized or malformed records and strips control characters', async () => {
    const dir = await tmp()
    const session = newSessionId()
    assert.equal(isSessionId('../../etc'), false)
    await (await beginActivity(dir, 'not-a-session', 'x'))()
    assert.deepEqual(await listActivity(dir, 'not-a-session'), [])
    await beginActivity(dir, session, 'agy:dev\u001b[2J\u0007')
    await writeFile(path.join(dir, 'junk.json'), '{not json')
    await writeFile(path.join(dir, 'big.json'), JSON.stringify({ session, pid: process.pid, label: 'x'.repeat(5000) }))
    await writeFile(path.join(dir, 'badpid.json'), JSON.stringify({ session, pid: -1, label: 'evil' }))
    assert.deepEqual(await listActivity(dir, session), ['agy:dev[2J'])
  })

  it('never throws when the directory cannot be created', async () => {
    const dir = await tmp()
    await writeFile(path.dirname(dir) + '/blocker', '')
    const end = await beginActivity(path.join(path.dirname(dir), 'blocker', 'active'), newSessionId(), 'x')
    await end()
    assert.deepEqual(await listActivity(path.join(path.dirname(dir), 'blocker', 'active'), newSessionId()), [])
  })
})

function fakeDispatch(delayMs: number, seen: { env?: NodeJS.ProcessEnv }): DispatchDeps {
  return {
    locate: (b) => `/bin/${b}`,
    exec: async (_bin, _args, opts) => {
      seen.env = opts.env
      await new Promise((r) => setTimeout(r, delayMs))
      return { exitCode: 0, stdout: JSON.stringify({ type: 'result', result: 'listo', session_id: 's1', usage: { input_tokens: 10 } }), stderr: '' }
    },
  }
}

describe('seb_delegate activity hook', () => {
  it('registers the delegation while the turn runs and clears it afterwards, also on failure', async () => {
    const events: string[] = []
    const crew = { role: async () => undefined, roles: async () => [] } as unknown as McpDeps['crew']
    const base: McpDeps = {
      crew,
      dispatch: fakeDispatch(5, {}),
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
    }
    await delegate(base, { agent: 'developer', prompt: 'x', host: 'claude' })
    assert.deepEqual(events, ['begin claude:developer', 'end'])

    events.length = 0
    const failing: McpDeps = { ...base, dispatch: { locate: () => '/bin/claude', exec: async () => Promise.reject(new Error('boom')) } }
    await delegate(failing, { agent: 'developer', prompt: 'x', host: 'claude' }).catch(() => {})
    assert.deepEqual(events, ['begin claude:developer', 'end'])
  })
})

describe('shell status bar with MCP delegations', () => {
  it('tags the turn with its session id and shows the MCP delegations while it runs', async () => {
    const input = new PassThrough()
    const output = Object.assign(new PassThrough(), { isTTY: true, rows: 24, columns: 240 })
    let written = ''
    output.on('data', (c: Buffer) => {
      written += c.toString()
    })
    const seen: { env?: NodeJS.ProcessEnv } = {}
    const asked: string[] = []
    const config = { ...defaultConfig(), orchestrator: 'claude' as const, hosts: ['claude' as const] }
    const done = runShell(
      { input: input as unknown as NodeJS.ReadStream, output: output as unknown as NodeJS.WriteStream, color: false },
      config,
      {
        dispatch: fakeDispatch(1600, seen),
        services: async () => [],
        reconfigure: async () => null,
        activity: async (session) => {
          asked.push(session)
          return ['agy:researcher · pro']
        },
        profiles: { active: async () => 'default', names: async () => ['default'], env: async () => ({}) },
      },
      'test',
    )
    input.write('hola\n')
    await new Promise((r) => setTimeout(r, 2000))
    input.write(':exit\n')
    input.end()
    await done

    assert.ok(isSessionId(seen.env?.[SESSION_ENV]), 'the host process gets the shell session id')
    assert.ok(asked.length > 0 && asked.every((s) => s === seen.env?.[SESSION_ENV]))
    assert.match(written, /sub 2 \(claude:main, agy:researcher · pro\)/)
  })
})
