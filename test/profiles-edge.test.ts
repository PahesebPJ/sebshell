import assert from 'node:assert/strict'
import { existsSync, lstatSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { SystemRuntime } from 'hubseb'
import { resolveProfile, runProfileCli } from '../src/profile-cli.ts'
import {
  activeProfileName,
  addProfile,
  loadProfiles,
  ProfileError,
  profilesFile,
  profilesRoot,
  provisionClaudeProfile,
  removeProfile,
  syncProfiles,
} from '../src/profiles.ts'

let home: string
let runtime: SystemRuntime

const mk = (env: Record<string, string> = {}) => new SystemRuntime({ homeDir: home, env: { HUBSEB_HOME: path.join(home, 'hub'), ...env } })

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'sebshell-edge-'))
  runtime = mk()
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

async function writeRegistry(content: unknown) {
  const file = profilesFile(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, typeof content === 'string' ? content : JSON.stringify(content))
}

async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; stdout: string; stderr: string }> {
  const so = process.stdout.write
  const se = process.stderr.write
  let stdout = ''
  let stderr = ''
  process.stdout.write = ((s: string | Uint8Array) => ((stdout += String(s)), true)) as typeof process.stdout.write
  process.stderr.write = ((s: string | Uint8Array) => ((stderr += String(s)), true)) as typeof process.stderr.write
  try {
    return { result: await fn(), stdout, stderr }
  } finally {
    process.stdout.write = so
    process.stderr.write = se
  }
}

describe('profiles edge cases', () => {
  it('provisions with no ~/.claude and no ~/.claude.json: nothing linked, no state file', async () => {
    const { profile, report } = await addProfile(runtime, 'claude', 'vacio')
    assert.deepEqual(report, { linked: [], mcpServersAdded: [], warnings: [] })
    assert.equal(existsSync(path.join(profile.configDir as string, '.claude.json')), false)
  })

  it('corrupt source ~/.claude.json is tolerated and adds no servers', async () => {
    await writeFile(path.join(home, '.claude.json'), '{not json')
    const { report } = await addProfile(runtime, 'claude', 'roto')
    assert.deepEqual(report.mcpServersAdded, [])
  })

  it('source ~/.claude.json without mcpServers or with null is tolerated', async () => {
    await writeFile(path.join(home, '.claude.json'), '{"mcpServers":null}')
    const { report } = await addProfile(runtime, 'claude', 'nulo')
    assert.deepEqual(report.mcpServersAdded, [])
  })

  it('never overwrites a corrupt profile .claude.json', async () => {
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { a: { command: 'a' } } }))
    const dir = path.join(home, 'p')
    await mkdir(dir)
    await writeFile(path.join(dir, '.claude.json'), '{corrupt')
    const report = await provisionClaudeProfile(runtime, dir)
    assert.deepEqual(report.mcpServersAdded, [])
    assert.equal(await readFile(path.join(dir, '.claude.json'), 'utf8'), '{corrupt')
  })

  it('keeps a real file already present in the profile instead of replacing it with a symlink', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'shared')
    await writeFile(path.join(home, '.claude', 'settings.json'), '{}')
    const dir = path.join(home, 'p')
    await mkdir(dir)
    await writeFile(path.join(dir, 'CLAUDE.md'), 'mine')
    const report = await provisionClaudeProfile(runtime, dir)
    assert.deepEqual(report.linked, ['settings.json'])
    assert.equal(lstatSync(path.join(dir, 'CLAUDE.md')).isSymbolicLink(), false)
    assert.equal(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8'), 'mine')
  })

  it('repairs a dangling symlink that occupies the target', async () => {
    await mkdir(path.join(home, '.claude'), { recursive: true })
    await writeFile(path.join(home, '.claude', 'CLAUDE.md'), 'shared')
    const dir = path.join(home, 'p')
    await mkdir(dir)
    const { symlink } = await import('node:fs/promises')
    await symlink(path.join(home, 'nowhere'), path.join(dir, 'CLAUDE.md'))
    const report = await provisionClaudeProfile(runtime, dir)
    assert.deepEqual(report.linked, ['CLAUDE.md'])
    assert.equal(await readFile(path.join(dir, 'CLAUDE.md'), 'utf8'), 'shared')
  })

  it('uses CLAUDE_CONFIG_DIR from the runtime env as shared root and state file', async () => {
    const shared = path.join(home, 'custom-claude')
    await mkdir(path.join(shared, 'agents'), { recursive: true })
    await writeFile(path.join(shared, '.claude.json'), JSON.stringify({ mcpServers: { x: { command: 'x' } } }))
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { wrong: {} } }))
    const rt = mk({ CLAUDE_CONFIG_DIR: shared })
    const { profile, report } = await addProfile(rt, 'claude', 'custom')
    assert.deepEqual(report.linked, ['agents'])
    assert.deepEqual(report.mcpServersAdded, ['x'])
    const state = JSON.parse(await readFile(path.join(profile.configDir as string, '.claude.json'), 'utf8'))
    assert.deepEqual(Object.keys(state.mcpServers), ['x'])
  })

  it('registry with invalid entries keeps only valid ones and drops dangling active', async () => {
    await writeRegistry({
      schema: 'sebshell-profiles/v1',
      profiles: [
        null,
        42,
        'str',
        { host: 'claude', name: 'ok', configDir: path.join(profilesRoot(runtime), 'claude', 'ok'), createdAt: '' },
        { host: 'claude', name: 'moved', configDir: '/elsewhere/moved', createdAt: '' },
        { host: 'claude', name: 'Bad Name', configDir: '/x', createdAt: '' },
        { host: 'claude', name: 'default', configDir: '/x', createdAt: '' },
        { host: 'claude', name: 'nodir', configDir: null, createdAt: '' },
        { host: 'nope', name: 'weird', configDir: '/x', createdAt: '' },
      ],
      active: { claude: 'ghost', antigravity: 'ok' },
    })
    const store = await loadProfiles(runtime)
    assert.deepEqual(store.profiles.map((p) => p.name), ['ok'])
    assert.deepEqual(store.active, {})
    assert.equal(activeProfileName(store, 'claude'), 'default')
  })

  it('a non-object or unparseable registry is a ProfileError (never silently emptied)', async () => {
    for (const raw of ['[]', 'null', '"x"', '{corrupt']) {
      await writeRegistry(raw)
      await assert.rejects(loadProfiles(runtime), ProfileError, raw)
      assert.ok(existsSync(`${profilesFile(runtime)}.corrupt`), raw)
    }
  })

  it('an object registry with wrong field types degrades to empty', async () => {
    await writeRegistry('{"profiles":"nope","active":7}')
    const store = await loadProfiles(runtime)
    assert.deepEqual([store.profiles, store.active], [[], {}])
  })

  it('registry with duplicate entries is deduplicated', async () => {
    const p = { host: 'claude', name: 'dup', configDir: path.join(profilesRoot(runtime), 'claude', 'dup'), createdAt: '' }
    await writeRegistry({ profiles: [p, p], active: {} })
    const store = await loadProfiles(runtime)
    assert.equal(store.profiles.length, 1)
  })

  it('resolveProfile fails with ProfileError for unknown explicit name and for dangling active', async () => {
    await assert.rejects(resolveProfile(runtime, 'claude', 'nada'), ProfileError)
    await writeRegistry({ profiles: [], active: { claude: 'ghost' } })
    assert.equal((await resolveProfile(runtime, 'claude')).name, 'default')
  })

  it('removeProfile --purge never deletes a configDir outside the profiles root', async () => {
    const outside = path.join(home, 'outside')
    await mkdir(outside)
    await writeFile(path.join(outside, 'keep'), '1')
    await writeRegistry({ profiles: [{ host: 'claude', name: 'evil', configDir: outside, createdAt: '' }], active: {} })
    // A tampered configDir is dropped at load time, so the profile does not even exist.
    await assert.rejects(removeProfile(runtime, 'claude', 'evil', true), /No existe/)
    assert.equal(existsSync(path.join(outside, 'keep')), true)
    assert.equal((await loadProfiles(runtime)).profiles.length, 0)
  })

  it('removeProfile --purge does not delete a sibling dir sharing the root prefix', async () => {
    const sibling = `${profilesRoot(runtime)}-evil`
    await mkdir(sibling, { recursive: true })
    await writeRegistry({ profiles: [{ host: 'claude', name: 'sib', configDir: sibling, createdAt: '' }], active: {} })
    await assert.rejects(removeProfile(runtime, 'claude', 'sib', true), /No existe/)
    assert.equal(existsSync(sibling), true)
  })

  it('syncProfiles skips profiles whose dir was deleted by recreating it', async () => {
    const { profile } = await addProfile(runtime, 'claude', 'gone')
    await rm(profile.configDir as string, { recursive: true })
    const res = await syncProfiles(runtime)
    assert.equal(res.length, 1)
    assert.equal(existsSync(profile.configDir as string), true)
  })

  it('addProfile rejects invalid names and unsupported hosts without writing the registry', async () => {
    for (const bad of ['', 'default', 'A', '-x', 'a b', '../x', 'a'.repeat(33)]) {
      await assert.rejects(addProfile(runtime, 'claude', bad), ProfileError, bad)
    }
    await assert.rejects(addProfile(runtime, 'antigravity', 'x'), ProfileError)
    assert.equal(existsSync(profilesFile(runtime)), false)
  })
})

describe('runProfileCli argument handling', () => {
  const cases: Array<[string, string[]]> = [
    ['unknown subcommand', ['bogus', 'claude', 'x']],
    ['missing host', ['add']],
    ['invalid host', ['add', 'nope', 'x']],
    ['add without name', ['add', 'claude']],
    ['use without name', ['use', 'claude']],
    ['rm without name', ['rm', 'claude']],
  ]
  for (const [label, args] of cases) {
    it(`exit 2 on ${label} (text mode)`, async () => {
      const { result, stderr, stdout } = await capture(() => runProfileCli(runtime, args, false))
      assert.equal(result, 2)
      assert.match(stderr, /sebshell profile/)
      assert.equal(stdout, '')
    })
    it(`exit 2 on ${label} (json mode, bad_args wire failure on stdout)`, async () => {
      const { result, stdout } = await capture(() => runProfileCli(runtime, args, true))
      assert.equal(result, 2)
      assert.match(stdout, /bad_args/)
    })
  }

  it('exit 1 (not 2) for semantic errors: invalid name, duplicate, unknown use/rm', async () => {
    assert.equal((await capture(() => runProfileCli(runtime, ['add', 'claude', 'Bad!'], false))).result, 1)
    assert.equal((await capture(() => runProfileCli(runtime, ['add', 'claude', 'ok'], false))).result, 0)
    assert.equal((await capture(() => runProfileCli(runtime, ['add', 'claude', 'ok'], false))).result, 1)
    assert.equal((await capture(() => runProfileCli(runtime, ['use', 'claude', 'ghost'], false))).result, 1)
    assert.equal((await capture(() => runProfileCli(runtime, ['rm', 'claude', 'ghost'], false))).result, 1)
    assert.equal((await capture(() => runProfileCli(runtime, ['rm', 'claude', 'default'], false))).result, 1)
  })

  it('rm claude --purge (flag in name slot) is a clean error, not a crash', async () => {
    const { result } = await capture(() => runProfileCli(runtime, ['rm', 'claude', '--purge'], false))
    assert.equal(result, 2, 'flags are never taken as the profile name')
  })

  it('use default clears the active profile and rm of the active profile resets it', async () => {
    await capture(() => runProfileCli(runtime, ['add', 'claude', 'w'], false))
    await capture(() => runProfileCli(runtime, ['use', 'claude', 'w'], false))
    assert.equal(activeProfileName(await loadProfiles(runtime), 'claude'), 'w')
    await capture(() => runProfileCli(runtime, ['rm', 'claude', 'w'], false))
    assert.equal(activeProfileName(await loadProfiles(runtime), 'claude'), 'default')
    assert.equal((await capture(() => runProfileCli(runtime, ['use', 'claude', 'default'], false))).result, 0)
  })

  it('agy and gemini aliases are not supported for add (exit 1) but parse as a valid host', async () => {
    const { result, stderr } = await capture(() => runProfileCli(runtime, ['add', 'agy', 'x'], false))
    assert.equal(result, 1)
    assert.match(stderr, /no están soportados/)
  })
})
