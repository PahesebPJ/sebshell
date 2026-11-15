import { existsSync, lstatSync } from 'node:fs'
import { chmod, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises'
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

export async function loadProfiles(runtime: SystemRuntime): Promise<ProfileStore> {
  const file = profilesFile(runtime)
  if (!existsSync(file)) return emptyStore()
  try {
    const raw = JSON.parse(await readFile(file, 'utf8')) as Partial<ProfileStore>
    const profiles = (Array.isArray(raw.profiles) ? raw.profiles : []).filter(
      (p): p is Profile =>
        Boolean(p) &&
        SHELL_HOSTS.includes(p.host) &&
        typeof p.name === 'string' &&
        isValidProfileName(p.name) &&
        p.name !== DEFAULT_PROFILE &&
        typeof p.configDir === 'string',
    )
    const active: Partial<Record<ShellHost, string>> = {}
    for (const host of SHELL_HOSTS) {
      const name = raw.active?.[host]
      if (typeof name === 'string' && profiles.some((p) => p.host === host && p.name === name)) active[host] = name
    }
    return { schema: 'sebshell-profiles/v1', profiles, active }
  } catch {
    return emptyStore()
  }
}

export async function saveProfiles(runtime: SystemRuntime, store: ProfileStore): Promise<void> {
  const file = profilesFile(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(tmp, file)
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

/** Environment overrides that make a host process use the given profile. */
export function profileEnv(profile: Profile): NodeJS.ProcessEnv {
  if (!profile.configDir) return {}
  if (profile.host === 'claude') return { CLAUDE_CONFIG_DIR: profile.configDir }
  return {}
}

export function claudeDefaultRoot(runtime: SystemRuntime): string {
  return runtime.env.CLAUDE_CONFIG_DIR ?? path.join(runtime.homeDir, '.claude')
}

function claudeDefaultStateFile(runtime: SystemRuntime): string {
  return runtime.env.CLAUDE_CONFIG_DIR
    ? path.join(runtime.env.CLAUDE_CONFIG_DIR, '.claude.json')
    : path.join(runtime.homeDir, '.claude.json')
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
}

/**
 * Idempotently prepares a Claude profile dir: links shared assets and merges user-scope MCP
 * servers missing from the profile. Never touches the profile's credentials.
 */
export async function provisionClaudeProfile(runtime: SystemRuntime, configDir: string): Promise<ProvisionReport> {
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  await chmod(configDir, 0o700)
  const shared = claudeDefaultRoot(runtime)
  const linked: string[] = []
  for (const entry of CLAUDE_SHARED_ENTRIES) {
    const source = path.join(shared, entry)
    const target = path.join(configDir, entry)
    if (!existsSync(source) || lexists(target)) continue
    await symlink(source, target)
    linked.push(entry)
  }

  const mcpServersAdded: string[] = []
  const sourceState = claudeDefaultStateFile(runtime)
  if (existsSync(sourceState)) {
    let servers: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(await readFile(sourceState, 'utf8')) as { mcpServers?: Record<string, unknown> }
      servers = parsed.mcpServers ?? {}
    } catch {
      servers = {}
    }
    const targetState = path.join(configDir, '.claude.json')
    let state: Record<string, unknown> = {}
    if (existsSync(targetState)) {
      try {
        state = JSON.parse(await readFile(targetState, 'utf8')) as Record<string, unknown>
      } catch {
        // A corrupt profile state is left alone rather than overwritten.
        return { linked, mcpServersAdded }
      }
    }
    const current = (state.mcpServers ?? {}) as Record<string, unknown>
    for (const [name, def] of Object.entries(servers)) {
      if (!(name in current)) {
        current[name] = def
        mcpServersAdded.push(name)
      }
    }
    if (mcpServersAdded.length > 0) {
      state.mcpServers = current
      const tmp = `${targetState}.${process.pid}.tmp`
      await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
      await rename(tmp, targetState)
    }
  }
  return { linked, mcpServersAdded }
}

export class ProfileError extends Error {}

export async function addProfile(runtime: SystemRuntime, host: ShellHost, name: string): Promise<{ profile: Profile; report: ProvisionReport }> {
  if (!supportsProfiles(host)) {
    throw new ProfileError(`Los perfiles de ${host} aún no están soportados (agy guarda la sesión en el keyring del sistema).`)
  }
  if (!isValidProfileName(name) || name === DEFAULT_PROFILE) {
    throw new ProfileError(`Nombre inválido "${name}": usa minúsculas, números y guiones (máx. 32), distinto de "default".`)
  }
  const store = await loadProfiles(runtime)
  if (findProfile(store, host, name)) throw new ProfileError(`El perfil ${host}/${name} ya existe.`)
  const configDir = path.join(profilesRoot(runtime), host, name)
  const report = await provisionClaudeProfile(runtime, configDir)
  const profile: Profile = { host, name, configDir, createdAt: new Date().toISOString() }
  store.profiles.push(profile)
  await saveProfiles(runtime, store)
  return { profile, report }
}

export async function useProfile(runtime: SystemRuntime, host: ShellHost, name: string): Promise<Profile> {
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
  const store = await loadProfiles(runtime)
  const profile = findProfile(store, host, name)
  if (!profile || !profile.configDir) throw new ProfileError(`No existe el perfil ${host}/${name}.`)
  store.profiles = store.profiles.filter((p) => p !== profile)
  if (store.active[host] === name) delete store.active[host]
  await saveProfiles(runtime, store)
  const root = profilesRoot(runtime)
  // Guard against deleting anything outside our own profiles tree.
  if (purge && path.resolve(profile.configDir).startsWith(path.resolve(root) + path.sep)) {
    await rm(profile.configDir, { recursive: true, force: true })
  }
  return profile
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
