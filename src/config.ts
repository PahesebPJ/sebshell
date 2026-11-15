import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { SystemRuntime } from 'hubseb'

export const SHELL_HOSTS = ['claude', 'antigravity'] as const
export type ShellHost = (typeof SHELL_HOSTS)[number]

export const COMPONENT_IDS = [
  'memoseb',
  'crewseb',
  'deckseb',
  'memosebui',
  'herdr-auto-title',
  'herdr-nvim-watcher',
] as const
export type ComponentId = (typeof COMPONENT_IDS)[number]

export const THEMES = ['aurora', 'ember', 'mono'] as const
export type ThemeName = (typeof THEMES)[number]

export const MODEL_PRESETS = ['default', 'lite', 'hard', 'hybrid', 'cloud-tiered'] as const
export type ModelPreset = (typeof MODEL_PRESETS)[number]

export interface ShellConfig {
  schema: 'sebshell-config/v1'
  hosts: ShellHost[]
  components: ComponentId[]
  orchestrator: ShellHost
  modelPreset: ModelPreset
  theme: ThemeName
  /** Overrides for context window sizes keyed by host; used when the host does not report it. */
  contextWindow: Partial<Record<ShellHost, number>>
  configuredAt: string
}

export function defaultConfig(): ShellConfig {
  return {
    schema: 'sebshell-config/v1',
    hosts: ['claude', 'antigravity'],
    components: ['memoseb', 'crewseb', 'herdr-auto-title'],
    orchestrator: 'claude',
    modelPreset: 'hybrid',
    theme: 'aurora',
    contextWindow: {},
    configuredAt: new Date().toISOString(),
  }
}

export function configFile(runtime: SystemRuntime): string {
  return path.join(runtime.configRoot, 'sebshell.json')
}

function pickValid<T extends string>(values: unknown, allowed: readonly T[], fallback: T[]): T[] {
  if (!Array.isArray(values)) return fallback
  const picked = values.filter((v): v is T => allowed.includes(v as T))
  return picked.length > 0 ? [...new Set(picked)] : fallback
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

export function normalizeConfig(raw: unknown): ShellConfig {
  const base = defaultConfig()
  if (!raw || typeof raw !== 'object') return base
  const r = raw as Record<string, unknown>
  const hosts = pickValid(r.hosts, SHELL_HOSTS, base.hosts)
  const orchestrator = oneOf(r.orchestrator, SHELL_HOSTS, hosts[0] ?? base.orchestrator)
  const contextWindow: Partial<Record<ShellHost, number>> = {}
  if (r.contextWindow && typeof r.contextWindow === 'object') {
    for (const [k, v] of Object.entries(r.contextWindow as Record<string, unknown>)) {
      if (SHELL_HOSTS.includes(k as ShellHost) && typeof v === 'number' && Number.isFinite(v) && v > 0) {
        contextWindow[k as ShellHost] = v
      }
    }
  }
  return {
    schema: 'sebshell-config/v1',
    hosts,
    components: pickValid(r.components, COMPONENT_IDS, base.components),
    orchestrator: hosts.includes(orchestrator) ? orchestrator : (hosts[0] ?? 'claude'),
    modelPreset: oneOf(r.modelPreset, MODEL_PRESETS, base.modelPreset),
    theme: oneOf(r.theme, THEMES, base.theme),
    contextWindow,
    configuredAt: typeof r.configuredAt === 'string' ? r.configuredAt : base.configuredAt,
  }
}

export async function loadConfig(runtime: SystemRuntime): Promise<ShellConfig | null> {
  const file = configFile(runtime)
  if (!existsSync(file)) return null
  try {
    return normalizeConfig(JSON.parse(await readFile(file, 'utf8')))
  } catch {
    return null
  }
}

export async function saveConfig(runtime: SystemRuntime, config: ShellConfig): Promise<string> {
  const file = configFile(runtime)
  await mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(tmp, file)
  return file
}
