import type { ShellHost } from './config.ts'
import { type CatalogModel, type CrewClient, type CrewRole, type CrewRoleInfo, describeEntry } from './crew.ts'
import type { EffortLevel } from './dispatch.ts'
import type { MenuOption, MenuResult } from './tui/menu.ts'

export interface EditorQuestion {
  id: string
  title: string
  options: MenuOption[]
  initial: string[]
}

export type EditorAsk = (q: EditorQuestion) => Promise<MenuResult<string>>

const HOST_LABEL: Record<ShellHost, string> = { claude: 'Claude Code', antigravity: 'Antigravity (agy)' }
const DONE = '__done'
const BACK = '__back'
const DEFAULT_EFFORT = '__default'

function roleHint(r: CrewRoleInfo): string {
  return `corre en ${r.runsOn ?? 'orquestador'} · claude ${describeEntry(r.hosts.claude)} · agy ${describeEntry(r.hosts.antigravity)}`
}

async function pick(ask: EditorAsk, q: EditorQuestion): Promise<string | null> {
  const res = await ask(q)
  if (res.kind !== 'submitted') return res.kind === 'aborted' ? DONE : null
  return res.values[0] ?? null
}

async function editHost(ask: EditorAsk, crew: CrewClient, info: CrewRoleInfo): Promise<string[] | null> {
  const choice = await pick(ask, {
    id: 'route',
    title: `¿Qué host ejecuta a ${info.role}?`,
    options: [
      { value: 'none', label: 'El orquestador de turno', hint: 'comportamiento estándar' },
      { value: 'claude', label: HOST_LABEL.claude, hint: 'agy lo delegará vía seb_delegate' },
      { value: 'antigravity', label: HOST_LABEL.antigravity, hint: 'Claude lo delegará vía seb_delegate' },
    ],
    initial: [info.runsOn ?? 'none'],
  })
  if (!choice || choice === DONE) return choice === DONE ? [] : null
  return crew.route(info.role, choice === 'none' ? null : (choice as ShellHost))
}

async function editModel(ask: EditorAsk, crew: CrewClient, info: CrewRoleInfo, host: ShellHost): Promise<string[] | null> {
  const models: CatalogModel[] = await crew.catalog(host)
  const current = info.hosts[host]
  const model = await pick(ask, {
    id: `model:${host}`,
    title: `Modelo de ${info.role} en ${HOST_LABEL[host]}`,
    options: models.map((m) => ({
      value: m.id,
      label: m.id,
      hint: m.nativeTier ? `${m.label} · sin esfuerzo` : `${m.label}${m.efforts.length ? ` · ${m.efforts.join('/')}` : ''}`,
    })),
    initial: [current?.model ?? ''],
  })
  if (!model || model === DONE) return model === DONE ? [] : null
  const entry = models.find((m) => m.id === model)

  let effort: EffortLevel | null = null
  if (entry && !entry.nativeTier && entry.efforts.length > 0) {
    const e = await pick(ask, {
      id: `effort:${host}`,
      title: `Esfuerzo de ${info.role} con ${model}`,
      options: [{ value: DEFAULT_EFFORT, label: 'Por defecto del modelo/tier' }, ...entry.efforts.map((x) => ({ value: x, label: x }))],
      initial: [current?.effort ?? DEFAULT_EFFORT],
    })
    if (!e || e === DONE) return e === DONE ? [] : null
    effort = e === DEFAULT_EFFORT ? null : (e as EffortLevel)
  }

  let tier: string | null = null
  if (host === 'antigravity' && entry && !entry.nativeTier) {
    // agy's own subagent loader only understands tiers; ask which one to fall back to.
    const t = await pick(ask, {
      id: 'tier',
      title: `${model} se aplica cuando sebshell invoca a ${info.role}. ¿Qué tier usan los subagentes que agy lanza por su cuenta?`,
      options: [
        { value: 'pro', label: 'pro', hint: 'el más capaz' },
        { value: 'flash', label: 'flash' },
        { value: 'flash_lite', label: 'flash_lite', hint: 'el más barato' },
        { value: 'inherit', label: 'inherit', hint: 'el modelo de la sesión de agy' },
      ],
      initial: [current?.native && current.native !== model ? current.native : 'pro'],
    })
    if (!t || t === DONE) return t === DONE ? [] : null
    tier = t
  }

  // One crewseb call (one redeploy): "none" clears a previous effort atomically with the model change.
  return crew.setModel(info.role, host, model, effort ?? (current?.effort ? 'none' : null), tier)
}

/**
 * Arrow-key editor for the crew matrix (role → host / model / effort). Every change goes
 * through crewseb's CLI, which validates it and redeploys the agents.
 */
export async function runCrewEditor(ask: EditorAsk, crew: CrewClient, notify: (lines: string[]) => Promise<void>): Promise<void> {
  let lastRole: string | null = null
  for (;;) {
    const roles = await crew.roles(true)
    const roleChoice = await pick(ask, {
      id: 'role',
      title: 'Tripulación: elige un subagente (esc para salir)',
      options: [...roles.map((r) => ({ value: r.role, label: r.role, hint: roleHint(r) })), { value: DONE, label: 'Listo' }],
      initial: lastRole ? [lastRole] : [],
    })
    if (!roleChoice || roleChoice === DONE) return
    lastRole = roleChoice
    const info = roles.find((r) => r.role === (roleChoice as CrewRole))
    if (!info) continue

    const action = await pick(ask, {
      id: 'action',
      title: `${info.role}: ${roleHint(info)}`,
      options: [
        { value: 'route', label: 'Host que lo ejecuta', hint: info.runsOn ?? 'orquestador' },
        { value: 'claude', label: 'Modelo y esfuerzo en Claude', hint: describeEntry(info.hosts.claude) },
        { value: 'antigravity', label: 'Modelo y esfuerzo en agy', hint: describeEntry(info.hosts.antigravity) },
        { value: BACK, label: 'Volver' },
      ],
      initial: ['route'],
    })
    if (action === DONE) return
    if (!action || action === BACK) continue

    try {
      const warnings = action === 'route' ? await editHost(ask, crew, info) : await editModel(ask, crew, info, action as ShellHost)
      if (warnings && warnings.length > 0) await notify(warnings)
    } catch (e) {
      await notify([`No se pudo aplicar: ${e instanceof Error ? e.message : String(e)}`])
    }
  }
}
