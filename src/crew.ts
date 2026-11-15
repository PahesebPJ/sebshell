import { decodeWire, type ProcessOutcome } from 'hubseb'
import { SHELL_HOSTS, type ShellHost } from './config.ts'
import { type EffortLevel, isEffortLevel } from './dispatch.ts'

export const CREW_ROLES = [
  'researcher',
  'analyst',
  'architect',
  'developer',
  'qa-automation',
  'devops',
  'sre',
  'security',
  'code-reviewer',
  'documenter',
] as const
export type CrewRole = (typeof CREW_ROLES)[number]

export function isCrewRole(v: unknown): v is CrewRole {
  return typeof v === 'string' && (CREW_ROLES as readonly string[]).includes(v)
}

const AGY_TIERS = new Set(['inherit', 'flash_lite', 'flash', 'pro'])

/** Mirrors crewseb's `models resolve` contract (crewseb >= 0.4.0). */
export interface CrewHostEntry {
  model: string
  native: string
  effort: EffortLevel | null
  appliedAt: 'frontmatter' | 'invocation'
}

export interface CrewRoleInfo {
  role: CrewRole
  tier: string
  runsOn: string | null
  hosts: Partial<Record<string, CrewHostEntry>>
}

export interface CatalogModel {
  id: string
  label: string
  efforts: EffortLevel[]
  nativeTier?: boolean
}

export interface CrewDeps {
  locate(bin: string): string | null
  exec(bin: string, args: readonly string[], opts: Record<string, never>): Promise<ProcessOutcome>
}

export class CrewError extends Error {}

/** What sebshell must pass at invocation so the role runs with its configured model/effort. */
export function invocationFor(info: CrewRoleInfo | undefined, host: ShellHost): { model: string | null; effort: EffortLevel | null } {
  const entry = info?.hosts?.[host]
  // Claude's frontmatter already carries model + effort; agy's can only carry a tier.
  if (!entry || entry.appliedAt !== 'invocation') return { model: null, effort: null }
  return {
    model: AGY_TIERS.has(entry.model) ? null : entry.model,
    effort: isEffortLevel(entry.effort) ? entry.effort : null,
  }
}

/** Host that should execute the role: its routing target if it is a shell host, else `fallback`. */
export function hostFor(info: CrewRoleInfo | undefined, fallback: ShellHost): ShellHost {
  const target = info?.runsOn
  return SHELL_HOSTS.find((h) => h === target) ?? fallback
}

export function describeEntry(entry: CrewHostEntry | undefined): string {
  if (!entry) return '—'
  const shown = entry.appliedAt === 'invocation' && !AGY_TIERS.has(entry.model) ? entry.model : entry.native
  return `${shown}${entry.effort ? `@${entry.effort}` : ''}`
}

export class CrewClient {
  private readonly deps: CrewDeps
  private cache: { at: number; roles: CrewRoleInfo[] } | null = null

  constructor(deps: CrewDeps) {
    this.deps = deps
  }

  get available(): boolean {
    return Boolean(this.deps.locate('crewseb'))
  }

  private async call<T>(args: string[]): Promise<T> {
    const exe = this.deps.locate('crewseb')
    if (!exe) throw new CrewError('crewseb no está instalado')
    const res = await this.deps.exec(exe, [...args, '--json'], {})
    let packet
    try {
      packet = decodeWire<T>(res.stdout)
    } catch {
      throw new CrewError(`crewseb ${args.join(' ')} no devolvió hubseb/v1 (¿crewseb < 0.4.0?): ${(res.stderr || res.stdout).trim().slice(0, 200)}`)
    }
    if (packet.status !== 'success') throw new CrewError(packet.fault.reason)
    return packet.payload
  }

  /** Role matrix, cached for a few seconds so a turn does not spawn crewseb repeatedly. */
  async roles(force = false): Promise<CrewRoleInfo[]> {
    if (!force && this.cache && Date.now() - this.cache.at < 5000) return this.cache.roles
    const { roles } = await this.call<{ roles: CrewRoleInfo[] }>(['models', 'resolve'])
    const valid = (Array.isArray(roles) ? roles : []).filter(
      (r): r is CrewRoleInfo => Boolean(r) && typeof r === 'object' && isCrewRole(r.role) && Boolean(r.hosts) && typeof r.hosts === 'object',
    )
    this.cache = { at: Date.now(), roles: valid }
    return valid
  }

  async role(role: CrewRole): Promise<CrewRoleInfo | undefined> {
    return (await this.roles()).find((r) => r.role === role)
  }

  async catalog(host: ShellHost, refresh = false): Promise<CatalogModel[]> {
    const args = ['models', 'catalog', '--host', host]
    if (refresh) args.push('--refresh')
    const { catalogs } = await this.call<{ catalogs: Array<{ models: CatalogModel[] }> }>(args)
    return catalogs[0]?.models ?? []
  }

  private async mutate(args: string[]): Promise<string[]> {
    this.cache = null
    const out = await this.call<{ warnings?: string[] }>(args)
    return Array.isArray(out.warnings) ? out.warnings : []
  }

  setModel(role: CrewRole, host: ShellHost, model: string, effort: EffortLevel | 'none' | null, tier: string | null): Promise<string[]> {
    const args = ['models', 'set', role, model, '--host', host]
    if (effort) args.push('--effort', effort)
    if (tier) args.push('--tier', tier)
    return this.mutate(args)
  }

  setEffort(role: CrewRole, host: ShellHost, effort: EffortLevel | null): Promise<string[]> {
    return this.mutate(['models', 'effort', role, effort ?? 'none', '--host', host])
  }

  route(role: CrewRole, host: ShellHost | null): Promise<string[]> {
    return this.mutate(['models', 'route', role, host ?? 'none'])
  }
}
