import assert from 'node:assert/strict'
import { existsSync, lstatSync, readlinkSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { SystemRuntime } from 'hubseb'
import { resolveProfile } from '../src/profile-cli.ts'
import {
  activeProfileName,
  addProfile,
  listProfiles,
  loadProfiles,
  parseClaudeAuthStatus,
  profileEnv,
  ProfileError,
  profilesFile,
  profilesRoot,
  removeProfile,
  syncProfiles,
  useProfile,
} from '../src/profiles.ts'

let home: string
let runtime: SystemRuntime

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'sebshell-prof-'))
  runtime = new SystemRuntime({ homeDir: home, env: { HUBSEB_HOME: path.join(home, 'hub') } })
  const claude = path.join(home, '.claude')
  await mkdir(path.join(claude, 'agents'), { recursive: true })
  await mkdir(path.join(claude, 'skills'), { recursive: true })
  await writeFile(path.join(claude, 'CLAUDE.md'), '# shared\n')
  await writeFile(path.join(claude, 'settings.json'), '{"hooks":{}}\n')
  await writeFile(path.join(claude, '.credentials.json'), '{"secret":"main-account"}\n')
  await writeFile(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { id: 'main' }, mcpServers: { memoseb: { command: 'memoseb' } } }))
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

describe('claude profiles', () => {
  it('creates an isolated 0700 dir sharing assets via symlinks but never credentials or account state', async () => {
    const { profile, report } = await addProfile(runtime, 'claude', 'trabajo')
    const dir = profile.configDir as string
    assert.equal(dir, path.join(profilesRoot(runtime), 'claude', 'trabajo'))
    assert.equal(statSync(dir).mode & 0o777, 0o700)
    assert.deepEqual(report.linked.sort(), ['CLAUDE.md', 'agents', 'settings.json', 'skills'])
    assert.ok(lstatSync(path.join(dir, 'agents')).isSymbolicLink())
    assert.equal(readlinkSync(path.join(dir, 'CLAUDE.md')), path.join(home, '.claude', 'CLAUDE.md'))
    assert.equal(existsSync(path.join(dir, '.credentials.json')), false, 'credentials are never shared')

    const state = JSON.parse(await readFile(path.join(dir, '.claude.json'), 'utf8'))
    assert.deepEqual(state, { mcpServers: { memoseb: { command: 'memoseb' } } }, 'only MCP servers are copied, not oauthAccount')
    assert.deepEqual(report.mcpServersAdded, ['memoseb'])
    assert.deepEqual(profileEnv(profile), { CLAUDE_CONFIG_DIR: dir })
  })

  it('sync is idempotent and merges newly added MCP servers without clobbering the profile', async () => {
    const { profile } = await addProfile(runtime, 'claude', 'personal')
    const stateFile = path.join(profile.configDir as string, '.claude.json')
    const state = JSON.parse(await readFile(stateFile, 'utf8'))
    await writeFile(stateFile, JSON.stringify({ ...state, oauthAccount: { id: 'personal' }, mcpServers: { ...state.mcpServers, local: { command: 'x' } } }))
    await writeFile(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: { memoseb: { command: 'memoseb' }, sebshell: { command: 'sebshell' } } }))

    const [first] = await syncProfiles(runtime)
    assert.deepEqual(first?.report, { linked: [], mcpServersAdded: ['sebshell'] })
    const merged = JSON.parse(await readFile(stateFile, 'utf8'))
    assert.deepEqual(merged.oauthAccount, { id: 'personal' })
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['local', 'memoseb', 'sebshell'])
    const [second] = await syncProfiles(runtime)
    assert.deepEqual(second?.report, { linked: [], mcpServersAdded: [] })
  })

  it('switches the active profile and resolves default when none is set', async () => {
    await addProfile(runtime, 'claude', 'trabajo')
    assert.equal((await resolveProfile(runtime, 'claude')).configDir, null)
    await useProfile(runtime, 'claude', 'trabajo')
    assert.equal(activeProfileName(await loadProfiles(runtime), 'claude'), 'trabajo')
    assert.equal((await resolveProfile(runtime, 'claude')).name, 'trabajo')
    await useProfile(runtime, 'claude', 'default')
    assert.equal(activeProfileName(await loadProfiles(runtime), 'claude'), 'default')
    assert.deepEqual(listProfiles(await loadProfiles(runtime), 'claude').map((p) => p.name), ['default', 'trabajo'])
    assert.equal(statSync(profilesFile(runtime)).mode & 0o777, 0o600)
  })

  it('removes profiles, purging the dir only on request, and resets the active one', async () => {
    const { profile } = await addProfile(runtime, 'claude', 'temp')
    await useProfile(runtime, 'claude', 'temp')
    await removeProfile(runtime, 'claude', 'temp', false)
    assert.ok(existsSync(profile.configDir as string), 'kept without --purge')
    assert.equal(activeProfileName(await loadProfiles(runtime), 'claude'), 'default')

    await addProfile(runtime, 'claude', 'temp2').then(({ profile: p }) => removeProfile(runtime, 'claude', p.name, true))
    assert.equal(existsSync(path.join(profilesRoot(runtime), 'claude', 'temp2')), false)
    assert.ok(existsSync(path.join(home, '.claude', 'CLAUDE.md')), 'purge never follows symlinks into shared assets')
  })

  it('never purges a dir outside the profiles tree even if the registry was tampered with', async () => {
    const victim = path.join(home, 'important')
    await mkdir(victim)
    await mkdir(path.dirname(profilesFile(runtime)), { recursive: true })
    await writeFile(
      profilesFile(runtime),
      JSON.stringify({ schema: 'sebshell-profiles/v1', profiles: [{ host: 'claude', name: 'evil', configDir: victim, createdAt: '' }], active: {} }),
    )
    await removeProfile(runtime, 'claude', 'evil', true)
    assert.ok(existsSync(victim))
  })

  it('rejects invalid names, duplicates, default and unsupported hosts', async () => {
    await assert.rejects(addProfile(runtime, 'claude', '../x'), ProfileError)
    await assert.rejects(addProfile(runtime, 'claude', 'Mayus'), ProfileError)
    await assert.rejects(addProfile(runtime, 'claude', 'default'), ProfileError)
    await addProfile(runtime, 'claude', 'a')
    await assert.rejects(addProfile(runtime, 'claude', 'a'), /ya existe/)
    await assert.rejects(addProfile(runtime, 'antigravity', 'b'), /keyring/)
    await assert.rejects(removeProfile(runtime, 'claude', 'default', true), /no se puede eliminar/)
    await assert.rejects(useProfile(runtime, 'claude', 'nope'), /No existe/)
    await assert.rejects(resolveProfile(runtime, 'claude', 'nope'), /profile add claude nope/)
  })

  it('tolerates a corrupt registry', async () => {
    await mkdir(path.dirname(profilesFile(runtime)), { recursive: true })
    await writeFile(profilesFile(runtime), '{oops')
    assert.deepEqual((await loadProfiles(runtime)).profiles, [])
  })
})

describe('claude auth status parsing', () => {
  it('extracts login state, email and plan', () => {
    assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}'), {
      loggedIn: true,
      email: 'a@b.c',
      plan: 'max',
    })
    assert.deepEqual(parseClaudeAuthStatus('{"loggedIn":false,"authMethod":"none"}'), { loggedIn: false, email: null, plan: null })
    assert.equal(parseClaudeAuthStatus('not json'), null)
  })
})
