import { randomBytes } from 'node:crypto'
import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { SystemRuntime } from 'hubseb'
import { SHELL_HOSTS, type ShellHost } from './config.ts'

export const DEFAULT_PROFILE = 'default'

export interface Profile {
  host: ShellHost
  name: string
  /** Isolated config dir; null means the host's own default location (the account you already use). */
  configDir: string | null
  createdAt: string
}

export interface ProfileStore {
  schema: 'sebshell-profiles/v1'
  profiles: Profile[]
  active: Partial<Record<ShellHost, string>>
}

/**
 * Entries shared with every Claude profile through symlinks, so crewseb agents, memoseb
 * directives, skills and herdr hooks stay identical across accounts. Credentials
 * (.credentials.json) and account state (.claude.json, history, projects) stay per profile.
 */
export const CLAUDE_SHARED_ENTRIES = ['CLAUDE.md', 'agents', 'skills', 'commands', 'hooks', 'plugins', 'settings.json'] as const

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/

export function isValidProfileName(name: string): boolean {
  return NAME.test(name)
}

export function supportsProfiles(host: ShellHost): boolean {
  // TODO: agy keeps its login in the OS keyring, so a separate dir does not isolate accounts.
  // Candidate: AGY_ACCOUNT env var — verify with a real second Google account before enabling.
  return host === 'claude'
}

export function profilesFile(runtime: SystemRuntime): string {
  return path.join(runtime.configRoot, 'sebshell-profiles.json')
}

export function profilesRoot(runtime: SystemRuntime): string {
  return path.join(runtime.stateRoot, 'sebshell', 'profiles')
}

function defaultProfile(host: ShellHost): Profile {
  return { host, name: DEFAULT_PROFILE, configDir: null, createdAt: '' }
}

function emptyStore(): ProfileStore {
  return { schema: 'sebshell-profiles/v1', profiles: [], active: {} }
}

export function expectedProfileDir(runtime: SystemRuntime, host: ShellHost, name: string): string {
  return path.join(profilesRoot(runtime), host, name)
}

/**
 * Loads the registry. A corrupt file is an error (never silently treated as empty, which would
 * make the next write wipe every profile); a `.corrupt` copy is kept for recovery.
 */
export async function loadProfiles(runtime: SystemRuntime): Promise<ProfileStore> {
  const file = profilesFile(runtime)
  if (!existsSync(file)) return emptyStore()
  let raw: Partial<ProfileStore>
  try {
    const parsed: unknown = JSON.parse(await readFile(file, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object')
    raw = parsed as Partial<ProfileStore>
  } catch {
    await copyFile(file, `${file}.corrupt`).catch(() => undefined)
    throw new ProfileError(`El registro de perfiles ${file} está corrupto (copia en ${file}.corrupt). Corrígelo o bórralo para continuar.`)
  }
  {
    const seen = new Set<string>()
    const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).filter((p): p is Profile => {
      if (!p || !SHELL_HOSTS.includes(p.host) || typeof p.name !== 'string') return false
      if (!isValidProfileName(p.name) || p.name === DEFAULT_PROFILE) return false
      // configDir is derived, never trusted from disk: a tampered path could aim sync/purge elsewhere.
      if (p.configDir !== expectedProfileDir(runtime, p.host, p.name)) return false
      const key = `${p.host}/${p.name}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    const active: Partial<Record<ShellHost, string>> = {}
    for (const host of SHELL_HOSTS) {
      const name = raw.active?.[host]
      if (typeof name === 'string' && profiles.some((p) => p.host === host && p.name === name)) active[host] = name
    }
    return { schema: 'sebshell-profiles/v1', profiles, active }
  }
}

export async function saveProfiles(runtime: SystemRuntime, store: ProfileStore): Promise<void> {
  const file = profilesFile(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  await atomicWrite(file, `${JSON.stringify(store, null, 2)}\n`)
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
}

/**
 * Serializes read-modify-write of the registry across processes with an mkdir lock
 * (atomic on POSIX). Locks older than 10s are considered stale and broken.
 */
export async function withRegistryLock<T>(runtime: SystemRuntime, fn: () => Promise<T>): Promise<T> {
  const lock = `${profilesFile(runtime)}.lock`
  await mkdir(path.dirname(lock), { recursive: true })
  const deadline = Date.now() + 5000
  for (;;) {
    try {
      await mkdir(lock)
      break
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
      try {
        if (Date.now() - lstatSync(lock).mtimeMs > 10_000) await rmdir(lock).catch(() => undefined)
      } catch {
        // lock vanished between checks; retry
      }
      if (Date.now() > deadline) throw new ProfileError(`El registro de perfiles está bloqueado (${lock}).`)
      await new Promise((r) => setTimeout(r, 50))
    }
  }
  try {
    return await fn()
  } finally {
    await rmdir(lock).catch(() => undefined)
  }
}

export function listProfiles(store: ProfileStore, host: ShellHost): Profile[] {
  return [defaultProfile(host), ...store.profiles.filter((p) => p.host === host)]
}

export function activeProfileName(store: ProfileStore, host: ShellHost): string {
  return store.active[host] ?? DEFAULT_PROFILE
}

export function findProfile(store: ProfileStore, host: ShellHost, name: string): Profile | null {
  if (name === DEFAULT_PROFILE) return defaultProfile(host)
  return store.profiles.find((p) => p.host === host && p.name === name) ?? null
}

/** Env vars that make Claude Code authenticate regardless of CLAUDE_CONFIG_DIR. */
export const CLAUDE_AUTH_OVERRIDES = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN'] as const

/**
 * Environment overrides that make a host process use the given profile. An `undefined` value
 * means "remove from the inherited env" (see mergeEnv): ambient credentials would otherwise
 * silently win over the profile's own login.
 */
export function profileEnv(profile: Profile): NodeJS.ProcessEnv {
  if (!profile.configDir || profile.host !== 'claude') return {}
  const env: NodeJS.ProcessEnv = { CLAUDE_CONFIG_DIR: profile.configDir }
  for (const key of CLAUDE_AUTH_OVERRIDES) env[key] = undefined
  return env
}

/** Merges env overrides, deleting keys explicitly set to undefined. */
export function mergeEnv(base: NodeJS.ProcessEnv, overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base }
  for (const [k, v] of Object.entries(overrides)) {
    if (v === undefined) delete out[k]
    else out[k] = v
  }
  return out
}

export function ambientClaudeCredentials(env: NodeJS.ProcessEnv): string[] {
  return CLAUDE_AUTH_OVERRIDES.filter((k) => Boolean(env[k]))
}

function isInside(child: string, parent: string): boolean {
  const rel = path.relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

/** The account-wide Claude root; a CLAUDE_CONFIG_DIR pointing at one of our profiles is ignored. */
export function claudeDefaultRoot(runtime: SystemRuntime): string {
  const fromEnv = runtime.env.CLAUDE_CONFIG_DIR
  if (fromEnv && !isInside(path.resolve(fromEnv), path.resolve(profilesRoot(runtime)))) return fromEnv
  return path.join(runtime.homeDir, '.claude')
}

function claudeDefaultStateFile(runtime: SystemRuntime): string {
  const root = claudeDefaultRoot(runtime)
  return root === path.join(runtime.homeDir, '.claude') ? path.join(runtime.homeDir, '.claude.json') : path.join(root, '.claude.json')
}

function lexists(p: string): boolean {
  try {
    lstatSync(p)
    return true
  } catch {
    return false
  }
}

export interface ProvisionReport {
  linked: string[]
  mcpServersAdded: string[]
  warnings: string[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v)

/**
 * Idempotently prepares a Claude profile dir: links shared assets and merges user-scope MCP
 * servers missing from the profile. Never touches the profile's credentials.
 */
export async function provisionClaudeProfile(runtime: SystemRuntime, configDir: string): Promise<ProvisionReport> {
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await chmod(configDir, 0o700)
  const shared = claudeDefaultRoot(runtime)
  const linked: string[] = []
  const warnings: string[] = []
  for (const entry of CLAUDE_SHARED_ENTRIES) {
    const source = path.join(shared, entry)
    const target = path.join(configDir, entry)
    if (!existsSync(source)) continue
    if (lexists(target)) {
      if (!lstatSync(target).isSymbolicLink()) {
        // Claude rewrites some files atomically, which replaces our symlink with a real file.
        warnings.push(`${entry} es un archivo propio del perfil (ya no se comparte); bórralo y ejecuta "sebshell profile sync" para re-enlazarlo`)
        continue
      }
      if (readlinkSync(target) === source && existsSync(target)) continue
      await unlink(target)
    }
    await symlink(source, target)
    linked.push(entry)
  }

  const mcpServersAdded: string[] = []
  const sourceState = claudeDefaultStateFile(runtime)
  if (!existsSync(sourceState)) return { linked, mcpServersAdded, warnings }
  let servers: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await readFile(sourceState, 'utf8'))
    if (isPlainObject(parsed) && isPlainObject(parsed.mcpServers)) servers = parsed.mcpServers
  } catch {
    warnings.push(`${sourceState} no es JSON válido; no se copiaron servidores MCP`)
    return { linked, mcpServersAdded, warnings }
  }
  const targetState = path.join(configDir, '.claude.json')
  let state: Record<string, unknown> = {}
  if (existsSync(targetState)) {
    try {
      const parsed: unknown = JSON.parse(await readFile(targetState, 'utf8'))
      if (!isPlainObject(parsed)) throw new Error('not an object')
      state = parsed
    } catch {
      // A corrupt profile state is left alone rather than overwritten.
      warnings.push(`${targetState} está corrupto; no se modificó`)
      return { linked, mcpServersAdded, warnings }
    }
  }
  const current: Record<string, unknown> = isPlainObject(state.mcpServers) ? { ...state.mcpServers } : {}
  // Additive only: edits/removals made on the default account are not propagated.
  for (const [name, def] of Object.entries(servers)) {
    if (name === '__proto__' || Object.hasOwn(current, name)) continue
    current[name] = def
    mcpServersAdded.push(name)
  }
  if (mcpServersAdded.length > 0) {
    state.mcpServers = current
    await atomicWrite(targetState, `${JSON.stringify(state, null, 2)}\n`)
  }
  return { linked, mcpServersAdded, warnings }
}

export class ProfileError extends Error {}

export async function addProfile(runtime: SystemRuntime, host: ShellHost, name: string): Promise<{ profile: Profile; report: ProvisionReport }> {
  if (!supportsProfiles(host)) {
    throw new ProfileError(`Los perfiles de ${host} aún no están soportados (agy guarda la sesión en el keyring del sistema).`)
  }
  if (!isValidProfileName(name) || name === DEFAULT_PROFILE) {
    throw new ProfileError(`Nombre inválido "${name}": usa minúsculas, números y guiones (máx. 32), distinto de "default".`)
  }
  return withRegistryLock(runtime, async () => {
    const store = await loadProfiles(runtime)
    if (findProfile(store, host, name)) throw new ProfileError(`El perfil ${host}/${name} ya existe.`)
    const configDir = expectedProfileDir(runtime, host, name)
    if (lexists(configDir)) {
      // A dir left by `rm` without --purge still holds that account's login.
      throw new ProfileError(`Ya existe ${configDir} (de un perfil anterior, con su sesión). Bórralo o elige otro nombre.`)
    }
    const profile: Profile = { host, name, configDir, createdAt: new Date().toISOString() }
    const report = await provisionClaudeProfile(runtime, configDir)
    store.profiles.push(profile)
    await saveProfiles(runtime, store)
    return { profile, report }
  })
}

export async function useProfile(runtime: SystemRuntime, host: ShellHost, name: string): Promise<Profile> {
  return withRegistryLock(runtime, () => useProfileUnlocked(runtime, host, name))
}

async function useProfileUnlocked(runtime: SystemRuntime, host: ShellHost, name: string): Promise<Profile> {
  const store = await loadProfiles(runtime)
  const profile = findProfile(store, host, name)
  if (!profile) throw new ProfileError(`No existe el perfil ${host}/${name}.`)
  if (name === DEFAULT_PROFILE) delete store.active[host]
  else store.active[host] = name
  await saveProfiles(runtime, store)
  return profile
}

/** Removes a profile from the registry; with `purge` also deletes its dir (and its credentials). */
export async function removeProfile(runtime: SystemRuntime, host: ShellHost, name: string, purge: boolean): Promise<Profile> {
  if (name === DEFAULT_PROFILE) throw new ProfileError('El perfil "default" no se puede eliminar.')
  return withRegistryLock(runtime, () => removeProfileUnlocked(runtime, host, name, purge))
}

async function removeProfileUnlocked(runtime: SystemRuntime, host: ShellHost, name: string, purge: boolean): Promise<Profile> {
  const store = await loadProfiles(runtime)
  const profile = findProfile(store, host, name)
  if (!profile || !profile.configDir) throw new ProfileError(`No existe el perfil ${host}/${name}.`)
  store.profiles = store.profiles.filter((p) => p !== profile)
  if (store.active[host] === name) delete store.active[host]
  await saveProfiles(runtime, store)
  if (purge) await purgeProfileDir(runtime, profile)
  return profile
}

/** Deletes a profile dir only if it is exactly our derived path, is a real dir, and resolves inside the tree. */
async function purgeProfileDir(runtime: SystemRuntime, profile: Profile): Promise<void> {
  const dir = expectedProfileDir(runtime, profile.host, profile.name)
  if (profile.configDir !== dir || !lexists(dir)) return
  if (lstatSync(dir).isSymbolicLink()) throw new ProfileError(`${dir} es un symlink; no se borra.`)
  const realRoot = realpathSync(profilesRoot(runtime))
  if (!isInside(realpathSync(dir), realRoot)) throw new ProfileError(`${dir} resuelve fuera de ${realRoot}; no se borra.`)
  await rm(dir, { recursive: true, force: true })
}

export async function syncProfiles(runtime: SystemRuntime): Promise<Array<{ profile: Profile; report: ProvisionReport }>> {
  const store = await loadProfiles(runtime)
  const out: Array<{ profile: Profile; report: ProvisionReport }> = []
  for (const p of store.profiles) {
    if (p.host === 'claude' && p.configDir) out.push({ profile: p, report: await provisionClaudeProfile(runtime, p.configDir) })
  }
  return out
}

export interface AccountStatus {
  loggedIn: boolean
  email: string | null
  plan: string | null
}

export function parseClaudeAuthStatus(stdout: string): AccountStatus | null {
  try {
    const j = JSON.parse(stdout) as Record<string, unknown>
    if (typeof j.loggedIn !== 'boolean') return null
    return {
      loggedIn: j.loggedIn,
      email: typeof j.email === 'string' ? j.email : null,
      plan: typeof j.subscriptionType === 'string' ? j.subscriptionType : typeof j.planTier === 'string' ? j.planTier : null,
    }
  } catch {
    return null
  }
}
